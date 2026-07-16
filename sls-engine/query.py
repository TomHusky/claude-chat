#!/usr/bin/env python3
"""阿里云 SLS 日志查询 CLI —— 供 Claude 直接排查后端微服务日志用。

环境与日志模型:
  dev / pro 是两个独立的 SLS Project（配置在 projects.{dev,pro}）。
  每个业务项目在 logs 里映射到 info / error 两个 logstore，两环境共用同一份映射。

用法示例:
  sls -q "* and level:ERROR" --env pro --app order            # 默认查 error 日志
  sls -q "traceId:abc" --env pro --app order --kind info       # 查 info 日志
  sls -q "*" --env dev --app order --kind both --from 2h       # info+error 都查
  sls -l order-error --env pro                                 # 直接指定 logstore
  sls apps                       # 列出已配置的业务项目及其 info/error logstore
  sls logstores --env pro        # 列出该环境 Project 下所有 logstore
  sls projects                   # 列出账号下所有 SLS Project

时间参数 --from/--to:
  相对: 30m / 2h / 1d (表示“多久以前”)，--to 缺省为“现在”，可写 0 表示现在
  绝对: 2026-07-11 14:00:00 (本地时区) 或 unix 时间戳

配置来源(优先级): --config 参数 > 环境变量 SLS_CONFIG > 同目录 config.json
"""
import argparse
import json
import os
import re
import sys
import time
import warnings
from datetime import datetime

# LibreSSL 下 urllib3 会打一条无害警告，别污染 stderr
warnings.filterwarnings("ignore", message=".*OpenSSL.*")

DEFAULT_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def config_path(args):
    return getattr(args, "config", None) or os.environ.get("SLS_CONFIG") or DEFAULT_CONFIG


def load_config(path):
    if not os.path.exists(path):
        die(f"找不到配置文件 {path}")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    for k in ("endpoint", "accessKeyId", "accessKeySecret"):
        if not cfg.get(k) or "REPLACE_ME" in str(cfg.get(k)):
            die(f"配置未填写完整: {k}。请编辑 {path}")
    return cfg


def resolve_project(cfg, args):
    """返回 (project 名, env)。--project 显式覆盖；否则按 --env 从 projects 取。
    环境名可自定义，先精确匹配、再大小写不敏感匹配，兼容 dev/Dev/PRO 之类写法。"""
    env = getattr(args, "env", None) or "pro"
    if getattr(args, "project", None):
        return args.project, env
    projects = cfg.get("projects", {})
    proj = projects.get(env)
    if not proj:  # 大小写不敏感兜底
        for k, v in projects.items():
            if k.lower() == env.lower():
                proj, env = v, k
                break
    if not proj:
        avail = "、".join(projects.keys()) or "(无)"
        die(f"环境 {env!r} 未配置 SLS Project（已配置的环境：{avail}）")
    return proj, env


def resolve_logstores(cfg, args):
    """返回 [(label, logstore), ...]。--logstore 直接指定；否则按 --app + --kind 从 logs 映射解析。"""
    if getattr(args, "logstore", None):
        return [(args.logstore, args.logstore)]
    app = getattr(args, "app", None)
    logs = cfg.get("logs", {})
    if not app:
        die("请用 --app <项目> 指定业务项目（或 -l 直接指定 logstore）。可用 sls apps 查看已配置项目")
    entry = logs.get(app)
    if not entry:
        avail = "、".join(logs.keys()) or "(空)"
        die(f"未配置的项目: {app}。已配置: {avail}")
    kind = getattr(args, "kind", None) or "error"
    kinds = ("error", "info") if kind == "both" else (kind,)
    out = []
    for k in kinds:
        ls = entry.get(k)
        if ls:
            out.append((f"{app}/{k}", ls))
    if not out:
        die(f"项目 {app} 未配置 {kind} 日志（logs.{app}.{kind}）")
    return out


def get_client(cfg):
    from aliyun.log import LogClient
    return LogClient(cfg["endpoint"], cfg["accessKeyId"], cfg["accessKeySecret"])


def cmd_projects(cfg, args):
    client = get_client(cfg)
    resp = client.list_project()
    for p in resp.get_projects():
        print(f"{p.get('projectName')}\t{p.get('description', '')}")


def cmd_apps(cfg, args):
    logs = cfg.get("logs", {})
    projects = cfg.get("projects", {})
    # 环境可自由增删——按配置里实际存在的逐个列出，别再假设只有 dev/pro。
    if projects:
        envs = "  ".join(f"{env}={proj or '(未配置)'}" for env, proj in projects.items())
    else:
        envs = "(未配置)"
    print(f"# 环境: {envs}")
    if not logs:
        print("(logs 映射为空)")
        return
    for app, entry in logs.items():
        print(f"{app}\tinfo={entry.get('info', '-')}\terror={entry.get('error', '-')}")


def cmd_logstores(cfg, args):
    client = get_client(cfg)
    project, _ = resolve_project(cfg, args)
    resp = client.list_logstore(project)
    stores = resp.get_logstores()
    if getattr(args, "json", False):
        print(json.dumps(stores, ensure_ascii=False))
        return
    for name in stores:
        print(name)


def _print_logs(logs, as_json):
    if as_json:
        out = []
        for log in logs:
            row = dict(log.get_contents())
            row["__time__"] = log.get_time()
            out.append(row)
        return out  # 交给调用方汇总
    for log in logs:
        ts = datetime.fromtimestamp(log.get_time()).strftime("%m-%d %H:%M:%S")
        contents = dict(log.get_contents())
        level = contents.pop("level", "") or contents.pop("__level__", "")
        msg = (contents.pop("message", "") or contents.pop("content", "")
               or contents.pop("msg", ""))
        head = f"[{ts}]"
        if level:
            head += f" {level}"
        print(head)
        if msg:
            print(f"  {msg}")
        for k, v in contents.items():
            if k.startswith("__") and k.endswith("__"):
                continue
            print(f"  {k}={v}")
        print()
    return None


def cmd_query(cfg, args):
    from aliyun.log import GetLogsRequest
    client = get_client(cfg)
    project, env = resolve_project(cfg, args)
    targets = resolve_logstores(cfg, args)

    from_ts = parse_time(args.from_time or "1h")
    to_ts = parse_time(args.to_time)
    if from_ts > to_ts:
        from_ts, to_ts = to_ts, from_ts
    tspan = (f"{datetime.fromtimestamp(from_ts):%Y-%m-%d %H:%M:%S} ~ "
             f"{datetime.fromtimestamp(to_ts):%Y-%m-%d %H:%M:%S}")

    json_out = []
    for label, logstore in targets:
        req = GetLogsRequest(project, logstore, from_ts, to_ts,
                             topic="", query=args.q, line=args.limit,
                             offset=0, reverse=not args.forward)
        logs = client.get_logs(req).get_logs()
        if args.json:
            json_out.append({
                "env": env, "project": project, "app": label, "logstore": logstore,
                "count": len(logs), "logs": _print_logs(logs, True),
            })
        else:
            hdr = f"# [{env}] {label} (project={project} logstore={logstore}) {tspan} query={args.q!r} -> {len(logs)} 条"
            print(hdr)
            print("-" * min(len(hdr), 100))
            _print_logs(logs, False)
    if args.json:
        print(json.dumps(json_out, ensure_ascii=False, indent=2))


def parse_time(val, default_now=True):
    """把 --from/--to 解析成 unix 秒。"""
    if val is None:
        return int(time.time()) if default_now else None
    val = str(val).strip()
    if val in ("0", "now", ""):
        return int(time.time())
    m = re.fullmatch(r"(\d+)\s*([smhd])", val)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        secs = n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
        return int(time.time()) - secs
    if re.fullmatch(r"\d{10,}", val):
        return int(val)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(val, fmt).timestamp())
        except ValueError:
            continue
    die(f"无法解析时间: {val!r}")


def build_parser():
    p = argparse.ArgumentParser(description="阿里云 SLS 日志查询")
    p.add_argument("--config", help="配置文件路径(默认同目录 config.json)")
    sub = p.add_subparsers(dest="cmd")

    def add_query_args(sp):
        sp.add_argument("-q", "--q", default="*", help="SLS 查询语句，默认 *")
        sp.add_argument("--env", help="环境名(对应 projects 里的 key，可自定义)，默认 pro")
        sp.add_argument("-a", "--app", help="业务项目名（logs 映射里的 key）")
        sp.add_argument("--kind", choices=["info", "error", "both"], help="查 info / error / both，默认 error")
        sp.add_argument("-l", "--logstore", help="直接指定 logstore（覆盖 --app/--kind）")
        sp.add_argument("-p", "--project", help="直接指定 SLS Project（覆盖 --env）")
        sp.add_argument("--from", dest="from_time", help="起始时间，默认 1h")
        sp.add_argument("--to", dest="to_time", help="结束时间，默认现在")
        sp.add_argument("-n", "--limit", type=int, default=20, help="返回条数，默认 20")
        sp.add_argument("--json", action="store_true", help="输出原始 JSON")
        sp.add_argument("--forward", action="store_true", help="按时间正序(默认倒序，最新在前)")

    add_query_args(p)
    sub.add_parser("projects", help="列出所有 SLS Project").add_argument("--config")
    sub.add_parser("apps", help="列出已配置的业务项目及其 info/error logstore").add_argument("--config")
    sp_ls = sub.add_parser("logstores", help="列出某环境 Project 下所有 logstore")
    sp_ls.add_argument("--env")
    sp_ls.add_argument("-p", "--project")
    sp_ls.add_argument("--json", action="store_true")
    sp_ls.add_argument("--config")
    sp_q = sub.add_parser("query", help="查询日志")
    add_query_args(sp_q)
    sp_q.add_argument("--config")
    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    cfg = load_config(config_path(args))
    try:
        if args.cmd == "projects":
            cmd_projects(cfg, args)
        elif args.cmd == "apps":
            cmd_apps(cfg, args)
        elif args.cmd == "logstores":
            cmd_logstores(cfg, args)
        else:  # query 或无子命令
            cmd_query(cfg, args)
    except Exception as e:  # 阿里云 LogException 等 -> 输出一行干净错误，不甩 traceback
        try:
            from aliyun.log.logexception import LogException
            if isinstance(e, LogException):
                die(f"SLS 错误: {e.get_error_code()} - {e.get_error_message()}")
        except ImportError:
            pass
        die(f"查询出错: {e}")


if __name__ == "__main__":
    main()
