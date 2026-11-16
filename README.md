# carta-relay — سيرفر وسيط للغرف (Cloudflare Workers + Durable Objects)

سيرفر مجاني ودائم للعب أونلاين ديال لعبة الكارطة المغربية.
ما كيفهم والو فاللعبة — غير كيمرّر الرسائل بين المضيف (Host) والعملاء،
وكيحاكي "اتصال TCP افتراضي" لكل عميل باش منطق LanNet يبقى كيف هو.

## الاتصال

- `wss://<worker>/host?code=ABCDE` ← المضيف (واحد فقط لكل غرفة)
- `wss://<worker>/join?code=ABCDE` ← كل عميل

## النشر — الطريقة 1: من المتصفح (Workers Builds) [PHONE OK]

1. سجّل حساب مجاني فـ https://dash.cloudflare.com/sign-up
2. من لوحة Cloudflare: Workers & Pages ← Create ← Connect to Git ← اختار هاد المستودع
3. Build command: `npx wrangler deploy` (أو خليه فارغاً — wrangler.toml كافي)
4. بعد النشر غادي يعطيك رابط بحال: `https://carta-relay.<سميتك>.workers.dev`
5. افتحو فالمتصفح: خاصو يكتب `carta relay ok`

## النشر — الطريقة 2: من الكمبيوتر [NEEDS PC]

1. سجّل حساب مجاني فـ https://dash.cloudflare.com/sign-up
2. ثبّت Node.js (نسخة LTS) فالكمبيوتر.
3. فالـ terminal داخل المجلد:
   ```
   npx wrangler login      (كيفتح المتصفح، قبل الإذن)
   npx wrangler deploy
   ```
4. فالآخر كيعطيك رابط بحال: `https://carta-relay.<سميتك>.workers.dev`
5. افتحو فالمتصفح: خاصو يكتب `carta relay ok`

## الأسرار — مهم

- هاد المستودع ما فيه حتى سر. أي سر فالمراحل الجاية
  (مثال: `ADMIN_SECRET` ديال لوحة الإدارة فالمرحلة 3)
  كيتخزن غير فـ Cloudflare dashboard ← Worker ← Settings ← Variables،
  وما كيتحطش أبداً فالملفات ولا فـ GitHub ولا فالشات.
- الرابط ديال الـ Worker عطيه للعبة (ServerConfig) باش تتصل بيه.

## الملفات

- `wrangler.toml` — إعدادات الـ Worker + ربط Durable Object `ROOM`
- `src/index.js` — كود الـ relay كامل
