// Netlify Function: secure server-side Telegram order delivery (CommonJS, Node 18+).
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set as Netlify runtime environment variables.
const { randomBytes } = require('node:crypto');

const CATALOG = {
  'panels-kit': { name: '5 плашек для Twitch', price: 500 },
  'identity-kit': { name: 'Логотип + баннер + офлайн', price: 500 },
  'emotes-kit': { name: '5 смайлов для чата', price: 500 },
  'full-kit': { name: 'Полный комплект', price: 1500 },
};
const counters = new Map(); // Per-instance best-effort rate limiting; consider CAPTCHA for public traffic.
function reply(statusCode, payload, extraHeaders = {}) {
  return {statusCode, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store', ...extraHeaders},body:JSON.stringify(payload)};
}
function clean(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0,limit) : '';
}
function validUrl(value) {
  if (!value) return true;
  try { let u=new URL(value); return ['http:','https:'].includes(u.protocol); } catch {return false;}
}
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return reply(405,{ok:false,error:'Метод не поддерживается.'},{Allow:'POST'});
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return reply(503,{ok:false,error:'Отправка заявок ещё не настроена владельцем сайта.'});

  // The function is intended to run on the website's own Netlify domain.
  // Use optional ALLOWED_SITE_ORIGIN for a stricter origin restriction.
  const origin = event.headers?.origin || event.headers?.Origin;
  if (process.env.ALLOWED_SITE_ORIGIN && origin && origin !== process.env.ALLOWED_SITE_ORIGIN) {
    return reply(403,{ok:false,error:'Отправка с этого сайта запрещена.'});
  }
  if (!event.body || Buffer.byteLength(event.body,'utf8') > 11000)
    return reply(413,{ok:false,error:'Слишком большой заказ.'});

  let data;
  try { data=JSON.parse(event.body); } catch {return reply(400,{ok:false,error:'Неверный формат заявки.'});}
  if (!data || typeof data !== 'object' || Array.isArray(data)) return reply(400,{ok:false,error:'Неверная заявка.'});
  // Honeypot: return a generic reply without sending bot/spam contents to Telegram.
  if (clean(data.company,100)) return reply(200,{ok:true,orderId:'—'});

  const nickname=clean(data.nickname,80);
  const contact=clean(data.contact,140);
  const channel=clean(data.channel,250);
  const brief=clean(data.brief,2000);
  if (!nickname || !contact || !validUrl(channel))
    return reply(400,{ok:false,error:'Проверьте ник, контакты и ссылку на канал.'});
  if (!Array.isArray(data.items) || data.items.length===0 || data.items.length>4)
    return reply(400,{ok:false,error:'Выберите хотя бы одну услугу.'});

  const seen=new Set();
  let sum=0; let count=0;
  const lines=[];
  for (const item of data.items) {
    if (!item || typeof item.id!=='string' || !CATALOG[item.id] || seen.has(item.id) || !Number.isInteger(item.qty) || item.qty<1 || item.qty>20)
      return reply(400,{ok:false,error:'Некорректный состав корзины.'});
    seen.add(item.id);
    const product=CATALOG[item.id];
    sum+=product.price*item.qty;count+=item.qty;
    lines.push(`• ${product.name}: ${item.qty} × ${product.price} ₽ = ${item.qty*product.price} ₽`);
  }
  // Best-effort limiter per serverless instance. For production add Turnstile if spam appears.
  const ip=event.headers?.['x-nf-client-connection-ip'] || event.headers?.['x-forwarded-for']?.split(',')[0] || 'unknown';
  const now=Date.now();
  for(const [k, v] of counters) if(now-v.start>60000) counters.delete(k);
  const prev=counters.get(ip)||{start:now,count:0};
  if(now-prev.start>60000){prev.start=now;prev.count=0;}
  prev.count++;counters.set(ip,prev);
  if(prev.count>5) return reply(429,{ok:false,error:'Слишком много заявок. Повторите чуть позже.'});

  const orderId=randomBytes(4).toString('hex').toUpperCase();
  const message=[
    '🟣 НОВЫЙ ЗАКАЗ · VYBE STUDIO',
    `Номер: ${orderId}`,
    '',
    `👤 Ник: ${nickname}`,
    `✉️ Контакт: ${contact}`,
    `🔗 Канал: ${channel || 'Не указан'}`,
    '',
    '📦 УСЛУГИ:',...lines,
    '',`💰 ИТОГО: ${sum} ₽ (${count} поз.)`,
    '', '📝 ТЕХНИЧЕСКОЕ ЗАДАНИЕ:',brief||'Обсудить с клиентом',
  ].join('\n');
  try {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),9000);
    let response, payload;
    try {
      response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:chat,text:message,disable_web_page_preview:true}),
        signal:controller.signal
      });
      payload=await response.json().catch(()=>({}));
    } finally {clearTimeout(timer);}
    if(!response.ok || !payload.ok) return reply(502,{ok:false,error:'Telegram не подтвердил доставку. Проверьте, что бот запущен и chat_id указан верно.'});
    return reply(200,{ok:true,orderId});
  } catch (_) {
    return reply(502,{ok:false,error:'Связь с Telegram временно недоступна. Попробуйте позднее.'});
  }
};
