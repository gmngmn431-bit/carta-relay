// =====================================================================
//  carta-relay — سيرفر وسيط للغرف (Cloudflare Workers + Durable Objects)
//
//  ما كيفهم والو فاللعبة. غير كيمرر الرسائل بين المضيف (Host) والعملاء،
//  وكيحاكي "اتصال TCP افتراضي" لكل عميل باش منطق LanNet يبقى كيف هو.
//
//  الاتصال:
//    wss://<worker>/host?code=ABCDE   ← المضيف (واحد فقط لكل غرفة)
//    wss://<worker>/join?code=ABCDE   ← كل عميل
//    wss://<worker>/match?mode=ronda&bet=10&players=2&uid=XXXX   ← البحث عن لاعبين (جديد)
//
//  البحث (/match): كل اللاعبين اللي عندهم نفس (النوع + الرهان + العدد) كيتجمعو
//  فنفس الطابور. ملي يتكمل العدد، السيرفر كيولد كود غرفة وكيبعث لكل واحد:
//     {"v":"wait","n":1,"need":2}                      ← تحديث الطابور
//     {"v":"match","code":"K7M2Q","host":true,"players":2}
//  أول واحد دخل الطابور كيولي مضيف، والباقي لاعبين. بعدها كيتسد اتصال البحث.
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

// ---- البحث عن لاعبين ----
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // نفس ServerConfig.RoomCodeChars
const TICKET_MAX_AGE_MS = 10 * 60 * 1000;                // تذكرة بحث كتموت من بعد 10 دقايق

function newRoomCode() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("carta relay ok");

    // ---------- البحث عن لاعبين ----------
    if (url.pathname === "/match") {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      const mode = (url.searchParams.get("mode") || "").toLowerCase();
      const bet = Number(url.searchParams.get("bet"));
      const players = Number(url.searchParams.get("players"));
      if (!/^[a-z_]{2,20}$/.test(mode)) return new Response("bad mode", { status: 400 });
      if (!Number.isInteger(bet) || bet < 0 || bet > 100000000) return new Response("bad bet", { status: 400 });
      if (!Number.isInteger(players) || players < 2 || players > 4) return new Response("bad players", { status: 400 });
      // طابور مستقل لكل تركيبة (نوع + رهان + عدد) — كيعاود يستعمل نفس Room DO
      return env.ROOM.getByName("mm:" + mode + ":" + bet + ":" + players).fetch(request);
    }

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
    const u = new URL(request.url);
    const path = u.pathname;

    // ---------- تذكرة بحث ----------
    if (path === "/match") return this.enqueue(request, u);

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

  // ======================= طابور البحث =======================
  enqueue(request, u) {
    const need = Number(u.searchParams.get("players"));
    const uid = (u.searchParams.get("uid") || "").slice(0, 64);

    // نفس اللاعب دخل مرتين (إعادة اتصال): نسدو التذكرة القديمة
    if (uid) {
      for (const w of this.ctx.getWebSockets("q")) {
        const a = w.deserializeAttachment() || {};
        if (a.uid === uid && a.state === "wait") { try { w.close(1000, "replaced"); } catch {} }
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["q"]);
    server.serializeAttachment({ uid, need, t: Date.now(), state: "wait" });

    this.tryMatch(need);
    return new Response(null, { status: 101, webSocket: client });
  }

  tryMatch(need) {
    const now = Date.now();
    const waiting = [];
    for (const w of this.ctx.getWebSockets("q")) {
      if (w.readyState !== 1) continue;   // مسدود/كيتسد: ما كيتحسبش
      const a = w.deserializeAttachment() || {};
      if (a.state !== "wait") continue;
      if (now - a.t > TICKET_MAX_AGE_MS) { try { w.close(1000, "timeout"); } catch {} continue; }
      waiting.push({ w, t: a.t });
    }
    waiting.sort((x, y) => x.t - y.t);   // الأقدم أولا

    if (waiting.length < need) {
      for (const e of waiting) {
        try { e.w.send(JSON.stringify({ v: "wait", n: waiting.length, need })); } catch {}
      }
      return;
    }

    // لقينا العدد: الأقدم = مضيف
    const group = waiting.slice(0, need);
    const code = newRoomCode();
    group.forEach((e, i) => {
      const a = e.w.deserializeAttachment() || {};
      a.state = "matched";
      e.w.serializeAttachment(a);
      try { e.w.send(JSON.stringify({ v: "match", code, host: i === 0, players: need })); } catch {}
      try { e.w.close(1000, "matched"); } catch {}
    });

    // إلا بقاو زايدين (نادر) كنعاودو
    if (waiting.length > need) {
      for (const e of waiting.slice(need)) {
        try { e.w.send(JSON.stringify({ v: "wait", n: waiting.length - need, need })); } catch {}
      }
      this.tryMatch(need);
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    const tag = this.ctx.getTags(ws)[0];
    if (tag === "q") return;   // تذكرة بحث: ما كتبعث والو

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

    if (tag === "q") {
      // لاعب لغا البحث: نحدّثو العدد للباقيين
      const a = ws.deserializeAttachment() || {};
      if (a.state === "wait") this.tryMatch(a.need);
      return;
    }

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
