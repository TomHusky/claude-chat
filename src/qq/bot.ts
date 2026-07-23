import * as https from "node:https";

/**
 * QQ 开放平台机器人客户端（WebSocket 长连接模式，零依赖）。
 *
 * 只负责协议：取 access_token、连 gateway、心跳、收单聊/群@消息、被动回复。
 * 业务（交给 Claude 处理并回话）由 provider 侧的桥接完成。
 *
 * 用 Node 22 内置的 global WebSocket —— 扩展宿主是 Electron 42/Node 22，不需要
 * 引入 `ws`，从而保持"无运行时依赖"的打包方式。
 */

/** QQ 群 + 单聊消息事件（官方 intent 位）。 */
const INTENT_GROUP_AND_C2C = 1 << 25;

export interface QQBotOptions {
  appId: string;
  appSecret: string;
  /** 用沙箱环境（q.qq.com 后台的"沙箱配置"里那套域名）。 */
  sandbox?: boolean;
  /** 白名单：只有这些 user openid 的消息才会被处理。空 = 谁都不响应。 */
  allowedOpenIds: string[];
}

export interface QQIncoming {
  text: string;
  msgId: string;
  scene: "c2c" | "group";
  userOpenId: string;
  groupOpenId?: string;
}

export type QQState = "connecting" | "online" | "offline";

export interface QQBotHooks {
  /** 通过白名单校验的用户消息。 */
  onMessage: (msg: QQIncoming) => void;
  /** 诊断日志（只进输出通道）。 */
  onLog: (line: string) => void;
  onState: (state: QQState, detail?: string) => void;
  /** 配对模式下有人发消息：把 openid 送到界面，一键填进白名单。 */
  onPairing: (openId: string) => void;
}

/** 简单的 JSON over HTTPS（避免引依赖）。 */
function httpJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = init.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body));
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: init.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": String(payload.length) } : {}),
          ...(init.headers ?? {}),
        },
        timeout: init.timeoutMs ?? 15_000,
      },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          let j: any;
          try {
            j = s ? JSON.parse(s) : {};
          } catch {
            return reject(new Error(`响应非 JSON (HTTP ${res.statusCode}): ${s.slice(0, 200)}`));
          }
          if ((res.statusCode ?? 0) >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(j).slice(0, 300)}`));
          }
          resolve(j);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class QQBot {
  private ws?: any; // global WebSocket（Node 22）；用 any 免受 @types/node 版本影响
  private token = "";
  private tokenExpiresAt = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private lastSeq: number | null = null;
  private stopped = false;
  private retry = 0;
  /** 每个 msg_id 的被动回复序号（官方要求同一 msg_id 的多次回复 msg_seq 递增）。 */
  private readonly msgSeq = new Map<string, number>();

  constructor(
    private readonly opts: QQBotOptions,
    private readonly hooks: QQBotHooks,
  ) {}

  /** 所有 hook 出口的安全层：宿主正在关闭时 output.appendLine / postMessage 会抛
   *  "Channel has been closed"，而 ws 的 onclose 恰恰在这个时序触发（实锤见
   *  exthost.log 异常栈）——回调失败一律吞掉，机器人绝不能把扩展宿主拖下水。 */
  private safeLog(line: string): void {
    try {
      this.hooks.onLog(line);
    } catch {
      /* host shutting down */
    }
  }

  private safeState(state: QQState, detail?: string): void {
    try {
      this.hooks.onState(state, detail);
    } catch {
      /* host shutting down */
    }
  }

  private get apiBase(): string {
    return this.opts.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
    this.msgSeq.clear();
    this.safeState("offline");
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;
  }

  /** 取（并缓存）access_token；提前 60s 视为过期。 */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const j = await httpJson("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      body: { appId: this.opts.appId, clientSecret: this.opts.appSecret },
    });
    if (!j?.access_token) throw new Error(`获取 access_token 失败：${JSON.stringify(j).slice(0, 200)}`);
    this.token = j.access_token;
    this.tokenExpiresAt = Date.now() + (Number(j.expires_in) || 7200) * 1000;
    return this.token;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.safeState("connecting");
    try {
      const token = await this.ensureToken();
      const gw = await httpJson(`${this.apiBase}/gateway`, { headers: { Authorization: `QQBot ${token}` } });
      const url = gw?.url;
      if (!url) throw new Error(`gateway 无 url：${JSON.stringify(gw).slice(0, 200)}`);

      const WS = (globalThis as any).WebSocket;
      if (!WS) throw new Error("当前 VS Code 运行时不支持 WebSocket（需要 Node 22+ 的宿主）");
      const ws = new WS(url);
      this.ws = ws;

      ws.onopen = () => this.safeLog("[qq] websocket 已连接，等待 Hello");
      ws.onmessage = (ev: any) => this.onFrame(String(ev.data));
      ws.onerror = () => this.safeLog("[qq] websocket 错误");
      ws.onclose = (ev: any) => {
        this.safeLog(`[qq] websocket 关闭 code=${ev?.code}`);
        if (this.ws === ws) this.scheduleReconnect();
      };
    } catch (err) {
      this.safeLog(`[qq] 连接失败：${String((err as Error)?.message ?? err)}`);
      this.safeState("offline", String((err as Error)?.message ?? err));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.ws = undefined;
    this.safeState("connecting");
    // 指数退避，封顶 60s——避免鉴权失败时疯狂重试打爆接口。
    const delay = Math.min(60_000, 2000 * Math.pow(2, Math.min(this.retry++, 5)));
    this.safeLog(`[qq] ${Math.round(delay / 1000)}s 后重连`);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private send(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch (err) {
      this.safeLog(`[qq] 发送失败：${String(err)}`);
    }
  }

  private onFrame(raw: string): void {
    let p: any;
    try {
      p = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof p.s === "number") this.lastSeq = p.s;
    switch (p.op) {
      case 10: {
        // Hello：拿到心跳间隔，先鉴权再开心跳。
        const interval = Number(p.d?.heartbeat_interval) || 30_000;
        this.send({
          op: 2,
          d: { token: `QQBot ${this.token}`, intents: INTENT_GROUP_AND_C2C, shard: [0, 1] },
        });
        this.heartbeatTimer = setInterval(() => this.send({ op: 1, d: this.lastSeq }), interval);
        return;
      }
      case 0:
        if (p.t === "READY") {
          this.retry = 0;
          this.safeState("online");
          this.safeLog(`[qq] 已上线：${p.d?.user?.username ?? ""}`);
        } else if (p.t === "C2C_MESSAGE_CREATE" || p.t === "GROUP_AT_MESSAGE_CREATE") {
          this.onUserMessage(p.t, p.d);
        }
        return;
      case 7: // 服务端要求重连
        this.safeLog("[qq] 服务端要求重连");
        this.scheduleReconnect();
        return;
      case 9: // 鉴权/参数非法——重试也没用，交由退避慢慢重来并记日志
        this.safeLog("[qq] 鉴权失败（op 9），请检查 AppID / AppSecret / 是否选错沙箱环境");
        this.scheduleReconnect();
        return;
      default:
        return;
    }
  }

  private onUserMessage(type: string, d: any): void {
    const scene: "c2c" | "group" = type === "C2C_MESSAGE_CREATE" ? "c2c" : "group";
    const userOpenId = scene === "c2c" ? d?.author?.user_openid : d?.author?.member_openid;
    const text = String(d?.content ?? "").trim();
    const msgId = d?.id;
    if (!userOpenId || !msgId) return;
    const target = { scene, userOpenId, groupOpenId: d?.group_openid, msgId };
    // 配对模式：白名单还没填时，把 openid 回给发信人（也打进日志），让他能复制到
    // 白名单里——openid 在 q.qq.com 后台查不到，只有消息事件里才有。
    // 告知本人自己的 openid 无风险：拿到它也进不了别人的白名单。
    if (!this.opts.allowedOpenIds.length) {
      this.safeLog(`[qq] 配对模式：来自 ${userOpenId} 的消息（白名单为空，暂不执行）`);
      this.hooks.onPairing(userOpenId);
      void this.reply(
        target,
        [
          "🔗 配对模式",
          "━━━━━━━━━━━━━",
          "机器人尚未授权任何人，你的 openid 是：",
          "",
          userOpenId,
          "",
          "请在 VS Code 打开「QQ 机器人」面板，",
          "点击弹出的「填入白名单并保存」即可。",
        ].join("\n"),
      );
      return;
    }
    // 白名单：远程消息会在本机跑工具，必须显式授权。
    if (!this.opts.allowedOpenIds.includes(userOpenId)) {
      this.safeLog(`[qq] 拒绝非白名单用户 ${userOpenId}`);
      void this.reply(target, "🚫 未授权\n该机器人只响应白名单用户");
      return;
    }
    if (!text) return;
    this.safeLog(`[qq] 收到消息 ${scene} ${userOpenId.slice(0, 8)} ${text.length}字`);
    this.hooks.onMessage({ text, msgId, scene, userOpenId, groupOpenId: d?.group_openid });
  }

  /** 被动回复。官方限制同一 msg_id 最多回 5 条，msg_seq 必须递增。 */
  async reply(
    target: { scene: "c2c" | "group"; userOpenId: string; groupOpenId?: string; msgId: string },
    text: string,
  ): Promise<void> {
    const seq = (this.msgSeq.get(target.msgId) ?? 0) + 1;
    if (seq > 5) {
      this.safeLog(`[qq] msg_id ${target.msgId} 已达 5 条回复上限，丢弃后续内容`);
      return;
    }
    this.msgSeq.set(target.msgId, seq);
    const path =
      target.scene === "group" && target.groupOpenId
        ? `/v2/groups/${target.groupOpenId}/messages`
        : `/v2/users/${target.userOpenId}/messages`;
    try {
      const token = await this.ensureToken();
      await httpJson(`${this.apiBase}${path}`, {
        method: "POST",
        headers: { Authorization: `QQBot ${token}` },
        body: { content: text, msg_type: 0, msg_id: target.msgId, msg_seq: seq },
      });
    } catch (err) {
      this.safeLog(`[qq] 回复失败：${String((err as Error)?.message ?? err)}`);
    }
  }

  /** msg_id 用完就清，避免 Map 无限增长。 */
  forget(msgId: string): void {
    this.msgSeq.delete(msgId);
  }
}

/** QQ 单条消息长度有限，把长回复切成若干段（最多 maxParts 段，超出截断）。 */
export function splitForQQ(text: string, maxLen = 800, maxParts = 4): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const parts: string[] = [];
  let rest = clean;
  while (rest && parts.length < maxParts) {
    if (rest.length <= maxLen) {
      parts.push(rest);
      rest = "";
      break;
    }
    // 尽量在换行处断开，读起来不至于拦腰截断。
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts[parts.length - 1] += `\n…（回复过长已截断，完整内容见 VS Code）`;
  return parts;
}
