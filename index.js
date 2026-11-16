// =====================================================================
//  carta-relay — سيرفر وسيط للغرف (Cloudflare Workers + Durable Objects)
//
//  ما كيفهم والو فاللعبة. غير كيمرر الرسائل بين المضيف (Host) والعملاء،
//  وكيحاكي "اتصال TCP افتراضي" لكل عميل باش منطق LanNet يبقى كيف هو.
//
//  الاتصال:
//    wss://<worker>/host?code=ABCDE   ← المضيف (واحد فقط لكل غرفة)
//    wss://<worker>/join?code=ABCDE   ← كل عميل
//
//  الرسائل (نص JSON) بين السيرفر والمضيف:
//    السيرفر → المضيف:  {"v":"open","c":"id"}            عميل جديد دخل
//                       {"v":"m","c":"id","l":"<سطر>"}   رسالة من العميل
//                       {"v":"close","c":"id"}           العميل خرج
//    المضيف → السيرفر:  {"v":"m","c":"id","l":"<سطر>"}   رسالة للعميل
//                       {"v":"kick","c":"id"}            طرد عميل
//  العميل كيبعث ويتوصل بالسطر الخام مباشرة (بلا غلاف).
//  "ping" من أي طرف كيتجاوب عليه "pong" أوتوماتيكيا بلا ما يوقظ الغرفة.
// =====================================================================
import { DurableObject } from "cloudflare:workers";

const MAX_CLIENTS = 6;        // 3 لاعبين + هامش لإعادة الاتصال
const MAX_MSG = 16 * 1024;    // أقصى حجم رسالة

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("carta relay ok");

    if (url.pathname !== "/host" && url.pathname !== "/join")
      return new Response("not found", { status: 404 });

    const code = (url.searchParams.get("code") || "").toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code))
      return new Response("bad code", { status: 400 });

    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });

    return env.ROOM.getByName(code).fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  hostSocket() {
    return this.ctx.getWebSockets("host")[0] || null;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const host = this.hostSocket();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (path === "/host") {
      if (host) return new Response("room exists", { status: 409 });
      this.ctx.acceptWebSocket(server, ["host"]);
    } else {
      if (!host) return new Response("no such room", { status: 404 });
      if (this.ctx.getWebSockets().length > MAX_CLIENTS + 1)
        return new Response("room full", { status: 403 });
      const id = crypto.randomUUID().slice(0, 8);
      this.ctx.acceptWebSocket(server, ["c:" + id]);
      host.send(JSON.stringify({ v: "open", c: id }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    const tag = this.ctx.getTags(ws)[0];

    if (tag === "host") {
      let m;
      try { m = JSON.parse(message); } catch { return; }
      if (!m || typeof m.c !== "string") return;
      const target = this.ctx.getWebSockets("c:" + m.c)[0];
      if (!target) return;
      if (m.v === "m" && typeof m.l === "string") target.send(m.l);
      else if (m.v === "kick") target.close(1000, "kicked");
    } else {
      const host = this.hostSocket();
      if (host)
        host.send(JSON.stringify({ v: "m", c: tag.slice(2), l: message }));
    }
  }

  async webSocketClose(ws) { this.dropped(ws); }
  async webSocketError(ws) { this.dropped(ws); }

  dropped(ws) {
    const tag = this.ctx.getTags(ws)[0];
    try { ws.close(1000, "bye"); } catch {}
    if (tag === "host") {
      // المضيف خرج ← الغرفة سالات
      for (const s of this.ctx.getWebSockets()) {
        if (s !== ws) { try { s.close(1001, "host left"); } catch {} }
      }
    } else {
      const host = this.hostSocket();
      if (host) host.send(JSON.stringify({ v: "close", c: tag.slice(2) }));
    }
  }
}
