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
        return json.load(f)


def _accounts(cfg):
    """归一成账号列表。新格式有 cfg['accounts']；旧的平铺格式把整个 cfg 当单账号。"""
    accts = cfg.get("accounts")
    if isinstance(accts, list) and accts:
        return accts
    return [cfg]


def _acct_label(a):
    return a.get("name") or "(未命名)"


def resolve_account(cfg, args):
    """挑出要用的账号 dict：--account 显式指定 > 按 --app 自动路由 > 第一个。"""
    accts = _accounts(cfg)
    name = getattr(args, "account", None)
    if name:
        for a in accts:
            if str(a.get("name", "")).strip().lower() == name.strip().lower():
                return _validate_account(a)
        die(f"未找到账号 {name!r}（已配置：{'、'.join(_acct_label(a) for a in accts)}）")
    if len(accts) > 1:
        app = getattr(args, "app", None)
        if app:
            owners = [a for a in accts if app in (a.get("logs") or {})]
            if len(owners) == 1:
                return _validate_account(owners[0])
            if len(owners) > 1:
                die(f"app {app!r} 在多个账号里都有，请加 --account 指定：{'、'.join(_acct_label(a) for a in owners)}")
        # 没传 --app（直接 --project / -l 查）：按 project 名归属路由，别默默落到第一个账号
        proj = getattr(args, "project", None)
        if proj:
            owners = [a for a in accts if proj in (a.get("projects") or {}).values()]
            if len(owners) == 1:
                return _validate_account(owners[0])
        if app or proj:
            die(f"无法判断 {app or proj!r} 属于哪个账号，请加 --account 指定（已配置：{'、'.join(_acct_label(a) for a in accts)}）")
    return _validate_account(accts[0])


def _validate_account(a):
    for k in ("endpoint", "accessKeyId", "accessKeySecret"):
        if not a.get(k) or "REPLACE_ME" in str(a.get(k)):
            die(f"账号 {_acct_label(a)} 未填写完整: {k}")
    return a


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
    acct = resolve_account(cfg, args)
    client = get_client(acct)
    resp = client.list_project()
    for p in resp.get_projects():
        print(f"{p.get('projectName')}\t{p.get('description', '')}")


def _print_one_account_apps(a):
    logs = a.get("logs", {})
    projects = a.get("projects", {})
    envs = "  ".join(f"{env}={proj or '(未配置)'}" for env, proj in projects.items()) if projects else "(未配置)"
    print(f"# 环境: {envs}")
    if not logs:
        print("(logs 映射为空)")
        return
    for app, entry in logs.items():
        print(f"{app}\tinfo={entry.get('info', '-')}\terror={entry.get('error', '-')}")


def cmd_apps(cfg, args):
    accts = _accounts(cfg)
    if len(accts) <= 1:
        _print_one_account_apps(accts[0] if accts else cfg)
        return
    # 多账号：分组列出，模型据此按 --app 自动路由（app 名唯一时无需 --account）
    for i, a in enumerate(accts):
        if i:
            print()
        print(f"## 账号: {_acct_label(a)}")
        _print_one_account_apps(a)


def cmd_logstores(cfg, args):
    acct = resolve_account(cfg, args)
    client = get_client(acct)
    project, _ = resolve_project(acct, args)
    resp = client.list_logstore(project)
    stores = resp.get_logstores()
    if getattr(args, "json", False):
        print(json.dumps(stores, ensure_ascii=False))
        return
    for name in stores:
        print(name)


# 单字段截断上限。生产 error 日志一条就是完整 Java 堆栈（100+ 行），20 条原样输出
# 动辄几万 token——消费方是 LLM 上下文，截断是省 token 的第一现场。
# 保头保尾：异常链的根因（Caused by）通常在尾部，纯砍尾会把最有用的部分砍掉。
FIELD_CAP = 700


def _cap(text, full):
    if full:
        return text
    t = str(text)
    # 刚过线就截断省不了几个字符还多出标记行——超出 300+ 才动手
    if len(t) <= FIELD_CAP + 300:
        return t
    return (t[: FIELD_CAP - 180] + f"\n  …(截断 {len(t) - FIELD_CAP} 字符, 加 --full 看全量)… \n"
            + t[-160:])


def _print_logs(logs, as_json, full=False):
    if as_json:
        out = []
        for log in logs:
            row = {k: _cap(v, full) for k, v in log.get_contents().items()}
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
            print(f"  {_cap(msg, full)}")
        for k, v in contents.items():
            if k.startswith("__") and k.endswith("__"):
                continue
            print(f"  {k}={_cap(v, full)}")
        print()
    return None


def cmd_query(cfg, args):
    from aliyun.log import GetLogsRequest
    acct = resolve_account(cfg, args)
    client = get_client(acct)
    project, env = resolve_project(acct, args)
    targets = resolve_logstores(acct, args)

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
        full = getattr(args, "full", False)
        if args.json:
            json_out.append({
                "env": env, "project": project, "app": label, "logstore": logstore,
                "count": len(logs), "logs": _print_logs(logs, True, full),
            })
        else:
            hdr = f"# [{env}] {label} (project={project} logstore={logstore}) {tspan} query={args.q!r} -> {len(logs)} 条"
            print(hdr)
            print("-" * min(len(hdr), 100))
            if not logs:
                # 空结果给出下一步指引而不是留白——避免模型盲目换参数反复全量扫
                print("(0 条。建议：先扩大时间 --from，或换 --kind both；换关键词前先用 -n 5 小样本试)")
                print()
            _print_logs(logs, False, full)
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
    p.add_argument("--account", help="多账号时指定账号名（不传则按 --app 自动路由，或用第一个）")
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
        sp.add_argument("-n", "--limit", type=int, default=10, help="返回条数，默认 10")
        sp.add_argument("--full", action="store_true", help="不截断单条日志（默认每字段截断到 700 字符）")
        sp.add_argument("--json", action="store_true", help="输出原始 JSON")
        sp.add_argument("--forward", action="store_true", help="按时间正序(默认倒序，最新在前)")

    add_query_args(p)
    _p_proj = sub.add_parser("projects", help="列出所有 SLS Project"); _p_proj.add_argument("--config"); _p_proj.add_argument("--account")
    sub.add_parser("apps", help="列出已配置的业务项目及其 info/error logstore").add_argument("--config")
    sp_ls = sub.add_parser("logstores", help="列出某环境 Project 下所有 logstore")
    sp_ls.add_argument("--env")
    sp_ls.add_argument("-p", "--project")
    sp_ls.add_argument("--json", action="store_true")
    sp_ls.add_argument("--config"); sp_ls.add_argument("--account")
    sp_q = sub.add_parser("query", help="查询日志")
    add_query_args(sp_q)
    sp_q.add_argument("--config"); sp_q.add_argument("--account")
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
