import { randomBytes } from "node:crypto";
import http from "node:http";

const MAX_BODY_BYTES = 16 * 1024;
const SAFE_ACTION_PATTERN = /^(?:start|pause|stop|reconnect|compact|rotateThread|setAutoSend|setMediaReactions|setModelEffort)$/u;

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex · 抖音桥</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <main>
    <header>
      <div><p class="eyebrow">LOCAL CONTROL</p><h1>Codex · 抖音桥</h1></div>
      <span id="overall" class="pill">连接中</span>
    </header>
    <section class="grid status-grid" aria-label="组件状态">
      <article><span>抖音网页</span><strong id="edge">—</strong></article>
      <article><span>消息桥</span><strong id="bridge">—</strong></article>
      <article><span>Codex</span><strong id="appServer">—</strong></article>
      <article><span>本地耳朵</span><strong id="audio">—</strong></article>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>上下文</h2><span id="contextLabel">等待首次回复</span></div>
      <div class="meter" role="progressbar" aria-label="上下文占用"><span id="contextBar"></span></div>
      <div class="meta"><span id="phase">阶段：—</span><span id="latency">最近耗时：—</span></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Codex 窗口</h2><span id="modelCurrent">—</span></div>
      <div class="form-row">
        <label>模型<select id="model"></select></label>
        <label>思考强度<select id="effort"></select></label>
        <button id="saveModel" data-action="setModelEffort">应用</button>
      </div>
      <p class="hint">“换新窗口”会保留抖音可见历史作为新上下文，但不会继续使用旧 Codex thread。</p>
    </section>
    <section class="panel controls">
      <div class="panel-head"><h2>运行控制</h2><div class="switches"><label class="switch"><input id="autoSend" type="checkbox"> 自动发送回复</label><label class="switch"><input id="mediaLike" type="checkbox"> 允许模型给媒体点赞</label></div></div>
      <div class="buttons">
        <button data-action="start">启动</button>
        <button data-action="pause">暂停</button>
        <button data-action="reconnect">重新连接</button>
        <button data-action="compact">压缩上下文</button>
        <button data-action="rotateThread">换新窗口</button>
        <button class="danger" data-action="stop">停止</button>
      </div>
      <p id="notice" class="notice" role="status">控制台只显示运行状态，不读取或保存聊天正文。</p>
    </section>
  </main>
  <script src="/app.js" defer></script>
</body>
</html>`;

const STYLE = `:root{color-scheme:dark;--bg:#090b10;--panel:#121620;--line:#282f3e;--text:#f4f6fb;--muted:#9da8ba;--accent:#75e3bd;--danger:#ff8d93}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#162332 0,transparent 38%),var(--bg);color:var(--text);font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;min-height:100vh}main{width:min(920px,calc(100% - 32px));margin:42px auto}header,.panel-head,.meta,.form-row,.buttons,.switches{display:flex;align-items:center}header{justify-content:space-between;margin-bottom:22px}h1{font-size:32px;margin:3px 0}.eyebrow{color:var(--accent);font-size:11px;letter-spacing:.2em;margin:0}.pill{padding:8px 13px;border-radius:999px;background:#253044;color:var(--muted)}.pill.ready{background:#15382e;color:var(--accent)}.pill.blocked{background:#431f28;color:#ffb2b6}.grid{display:grid;gap:12px}.status-grid{grid-template-columns:repeat(4,1fr)}article,.panel{background:rgba(18,22,32,.94);border:1px solid var(--line);border-radius:16px;padding:18px}article span,.hint,.meta,.notice{color:var(--muted);font-size:13px}article strong{display:block;margin-top:8px;font-size:18px}.panel{margin-top:12px}.panel-head{justify-content:space-between;gap:16px}.panel h2{margin:0;font-size:18px}.meter{height:10px;background:#252b37;border-radius:99px;overflow:hidden;margin:18px 0 12px}.meter span{display:block;height:100%;width:0;background:linear-gradient(90deg,#66ddb5,#ffd877,#ff8d93);transition:width .25s}.meta{justify-content:space-between}.form-row{gap:12px;margin-top:16px;align-items:end}.form-row label{display:grid;gap:7px;color:var(--muted);font-size:13px;flex:1}select,button{font:inherit;color:var(--text);background:#202735;border:1px solid #354055;border-radius:10px;padding:10px 12px}button{cursor:pointer}button:hover:not(:disabled){border-color:var(--accent)}button:disabled{opacity:.38;cursor:not-allowed}.buttons{gap:9px;flex-wrap:wrap;margin-top:16px}.danger{color:var(--danger)}.switches{gap:16px;flex-wrap:wrap;justify-content:flex-end}.switch{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:14px}.notice{min-height:20px;margin:14px 0 0}.notice.error{color:#ffb2b6}.hint{margin:12px 0 0}@media(max-width:680px){main{margin:24px auto}.status-grid{grid-template-columns:repeat(2,1fr)}.form-row{align-items:stretch;flex-direction:column}.panel-head{align-items:flex-start;flex-direction:column}.switches{align-items:flex-start;flex-direction:column;gap:8px}header{align-items:flex-start}h1{font-size:26px}}`;

const APP = `let csrfToken="";let models=[];let lastStatus=null;const $=(id)=>document.getElementById(id);const labels={ready:"就绪",running:"运行中",offline:"离线",starting:"启动中",unknown:"等待检测",unavailable:"不可用",paused:"已暂停",blocked:"已安全停止",listening:"正在等消息",processing:"正在理解",sending:"正在发送",compacting:"正在压缩",restarting:"正在恢复",stopping:"正在停止","waiting-for-edge":"等待抖音网页"};function label(value){return labels[value]||String(value||"—")}function setNotice(text,error=false){$("notice").textContent=text;$("notice").classList.toggle("error",error)}async function json(url,options){const response=await fetch(url,{cache:"no-store",...options});const body=await response.json();if(!response.ok)throw new Error(body.error||("HTTP "+response.status));return body}function renderModels(status){const model=$("model");if(model.options.length===0){for(const entry of models){const option=document.createElement("option");option.value=entry.id;option.textContent=entry.displayName;model.append(option)}}if([...model.options].some((option)=>option.value===status.model))model.value=status.model;renderEfforts(status.effort)}function renderEfforts(selected){const model=models.find((entry)=>entry.id===$("model").value);const effort=$("effort");const values=model?.supportedEfforts||[];const previous=selected||effort.value;effort.replaceChildren();for(const value of values){const option=document.createElement("option");option.value=value;option.textContent=value;effort.append(option)}if(values.includes(previous))effort.value=previous}function render(status){lastStatus=status;$("edge").textContent=label(status.edge);$("bridge").textContent=label(status.bridge);$("appServer").textContent=label(status.appServer);$("audio").textContent=label(status.audio);$("phase").textContent="阶段："+label(status.phase);$("modelCurrent").textContent=status.model+" · "+status.effort;$("autoSend").checked=status.sendEnabled;$("mediaLike").checked=status.mediaReactionEnabled;const usage=status.contextUsage;if(usage){const percent=Math.min(100,Math.max(0,usage.ratio*100));$("contextBar").style.width=percent.toFixed(1)+"%";$("contextLabel").textContent=Math.round(usage.contextTokens).toLocaleString()+" / "+Math.round(usage.modelContextWindow).toLocaleString()+" tokens（"+percent.toFixed(1)+"%）"}else{$("contextBar").style.width="0";$("contextLabel").textContent="等待首次回复"}$("latency").textContent="最近耗时："+(Number.isFinite(status.lastLatencyMs)?(status.lastLatencyMs/1000).toFixed(1)+" 秒":"—");const overall=$("overall");overall.textContent=label(status.phase);overall.className="pill "+(status.phase==="listening"?"ready":status.phase==="blocked"?"blocked":"");for(const button of document.querySelectorAll("button[data-action]")){button.disabled=!status.actionPermissions?.[button.dataset.action]}$("autoSend").disabled=!status.actionPermissions?.setAutoSend;$("mediaLike").disabled=!status.actionPermissions?.setMediaReactions;renderModels(status)}async function refresh(){try{const status=await json("/api/status");render(status)}catch(error){setNotice("控制台连接失败："+error.message,true)}}async function action(name,payload={}){try{setNotice("正在执行…");const result=await json("/api/action",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrfToken},body:JSON.stringify({action:name,payload})});render(result.status||lastStatus);setNotice("操作已完成。")}catch(error){setNotice(error.message,true);await refresh()}}async function boot(){try{csrfToken=(await json("/api/session")).csrfToken;models=await json("/api/models");await refresh();setInterval(refresh,1500)}catch(error){setNotice("控制台初始化失败："+error.message,true)}}$("model").addEventListener("change",()=>renderEfforts());$("saveModel").addEventListener("click",()=>action("setModelEffort",{model:$("model").value,effort:$("effort").value}));$("autoSend").addEventListener("change",()=>action("setAutoSend",{sendEnabled:$("autoSend").checked}));$("mediaLike").addEventListener("change",()=>action("setMediaReactions",{mediaReactionEnabled:$("mediaLike").checked}));for(const button of document.querySelectorAll("button[data-action]:not(#saveModel)")){button.addEventListener("click",()=>{const name=button.dataset.action;if((name==="rotateThread"||name==="stop")&&!confirm(name==="rotateThread"?"确定换一个新的 Codex 窗口吗？":"确定停止抖音桥吗？"))return;action(name)})}boot();`;

function jsonResponse(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function staticResponse(response, contentType, body) {
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request-too-large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid-json"));
      }
    });
    request.on("error", reject);
  });
}

export function createDouyinControlServer({
  controller,
  host = "127.0.0.1",
  port = 43_127,
  csrfToken = randomBytes(32).toString("base64url"),
} = {}) {
  if (!controller || typeof controller.getStatus !== "function"
      || typeof controller.performAction !== "function") {
    throw new Error("A Douyin supervisor controller is required.");
  }
  if (host !== "127.0.0.1") throw new Error("The control server must bind to 127.0.0.1.");
  let origin = null;
  const server = http.createServer(async (request, response) => {
    try {
      const hostHeader = request.headers.host;
      if (!origin || hostHeader !== origin.slice("http://".length)) {
        jsonResponse(response, 403, { ok: false, error: "Host is not allowed." });
        return;
      }
      const url = new URL(request.url, origin);
      if (request.method === "GET" && url.pathname === "/") {
        staticResponse(response, "text/html; charset=utf-8", PAGE);
        return;
      }
      if (request.method === "GET" && url.pathname === "/app.css") {
        staticResponse(response, "text/css; charset=utf-8", STYLE);
        return;
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        staticResponse(response, "text/javascript; charset=utf-8", APP);
        return;
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        jsonResponse(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        jsonResponse(response, 200, { ok: true, csrfToken });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        jsonResponse(response, 200, controller.getStatus());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/models") {
        jsonResponse(response, 200, await controller.listModels());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/action") {
        if (request.headers.origin !== origin || request.headers["x-csrf-token"] !== csrfToken) {
          jsonResponse(response, 403, { ok: false, error: "Control authorization failed." });
          return;
        }
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
          jsonResponse(response, 415, { ok: false, error: "JSON content type is required." });
          return;
        }
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
            || !SAFE_ACTION_PATTERN.test(body.action || "")) {
          jsonResponse(response, 400, { ok: false, error: "Control action is invalid." });
          return;
        }
        const result = await controller.performAction(body.action, body.payload ?? {});
        jsonResponse(response, 200, {
          ok: true,
          result,
          status: controller.getStatus(),
        });
        return;
      }
      jsonResponse(response, 404, { ok: false, error: "Not found." });
    } catch (error) {
      const statusCode = error?.message === "request-too-large" ? 413
        : error?.message === "invalid-json" ? 400
          : 409;
      const actionMessage = String(error?.message || "Action failed.");
      const safeMessage = statusCode === 409
        ? (/^[A-Za-z0-9 ._-]{1,180}$/u.test(actionMessage)
          ? actionMessage
          : "Action failed; check supervisor status.")
        : statusCode === 413 ? "Request is too large." : "Request JSON is invalid.";
      jsonResponse(response, statusCode, { ok: false, error: safeMessage });
    }
  });

  return {
    get url() {
      return origin;
    },
    async listen() {
      if (origin) return origin;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      origin = `http://${host}:${address.port}`;
      return origin;
    },
    close() {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
