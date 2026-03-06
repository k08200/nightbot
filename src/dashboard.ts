import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { LLM } from "./llm.js";
import { loadTasks } from "./task.js";

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EVE Monitor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; }
  .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 20px; color: #58a6ff; }
  .status-badge { padding: 4px 12px; border-radius: 12px; font-size: 13px; font-weight: 600; }
  .status-badge.online { background: #1b4332; color: #2dd4bf; }
  .status-badge.offline { background: #3b1c1c; color: #f87171; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; padding: 24px; max-width: 1400px; margin: 0 auto; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  .card-header { padding: 12px 16px; border-bottom: 1px solid #30363d; font-weight: 600; font-size: 14px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-body { padding: 16px; max-height: 500px; overflow-y: auto; }
  .task-item { padding: 8px 12px; border-radius: 6px; margin-bottom: 6px; background: #0d1117; border: 1px solid #21262d; }
  .task-item .id { font-size: 11px; color: #8b949e; font-family: monospace; }
  .task-item .question { font-size: 13px; margin-top: 2px; }
  .task-status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .task-status.pending { background: #d29922; }
  .task-status.running { background: #58a6ff; animation: pulse 1s infinite; }
  .task-status.done { background: #3fb950; }
  .task-status.failed { background: #f85149; }
  .task-status.escalated { background: #bc8cff; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .report-item { padding: 8px 12px; margin-bottom: 6px; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; cursor: pointer; }
  .report-item:hover { border-color: #58a6ff; }
  .report-item .name { font-size: 13px; font-family: monospace; }
  .report-item .preview { font-size: 12px; color: #8b949e; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .escalation-item { padding: 10px 12px; margin-bottom: 6px; background: #1c1216; border: 1px solid #f8514933; border-radius: 6px; }
  .escalation-item .level { font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .escalation-item .msg { font-size: 13px; margin-top: 4px; }
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; padding: 0 24px 12px; max-width: 1400px; margin: 0 auto; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
  .stat .num { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .stat .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .empty { text-align: center; padding: 24px; color: #484f58; font-size: 13px; }
  .modal-bg { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 100; }
  .modal-bg.active { display: flex; align-items: center; justify-content: center; }
  .modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; width: 80%; max-width: 800px; max-height: 80vh; overflow: auto; padding: 24px; }
  .modal pre { white-space: pre-wrap; font-size: 13px; line-height: 1.5; }
  .modal .close { float: right; cursor: pointer; color: #8b949e; font-size: 20px; }
</style>
</head>
<body>
<div class="header">
  <h1>EVE Monitor</h1>
  <span id="llmStatus" class="status-badge offline">Checking...</span>
</div>
<div class="stats" id="stats"></div>
<div class="grid">
  <div class="card">
    <div class="card-header">Task Queue</div>
    <div class="card-body" id="queue"></div>
  </div>
  <div class="card">
    <div class="card-header">Reports</div>
    <div class="card-body" id="reports"></div>
  </div>
  <div class="card">
    <div class="card-header">Escalations</div>
    <div class="card-body" id="escalations"></div>
  </div>
</div>
<div class="modal-bg" id="modalBg" onclick="closeModal()">
  <div class="modal" onclick="event.stopPropagation()">
    <span class="close" onclick="closeModal()">&times;</span>
    <pre id="modalContent"></pre>
  </div>
</div>
<script>
const API = '';
async function fetchJSON(path) {
  const r = await fetch(API + path);
  return r.json();
}
function closeModal() { document.getElementById('modalBg').classList.remove('active'); }
function showModal(text) {
  document.getElementById('modalContent').textContent = text;
  document.getElementById('modalBg').classList.add('active');
}
async function loadReport(name) {
  const data = await fetchJSON('/api/reports/' + encodeURIComponent(name));
  showModal(data.content || 'No content');
}
async function refresh() {
  try {
    const [status, queue, reports, escalations] = await Promise.all([
      fetchJSON('/api/status'),
      fetchJSON('/api/queue'),
      fetchJSON('/api/reports'),
      fetchJSON('/api/escalations'),
    ]);
    const badge = document.getElementById('llmStatus');
    badge.textContent = status.llmAvailable ? 'Claude Connected' : 'Claude Offline';
    badge.className = 'status-badge ' + (status.llmAvailable ? 'online' : 'offline');
    const counts = { pending: 0, running: 0, done: 0, failed: 0, escalated: 0 };
    for (const t of queue) counts[t.status] = (counts[t.status] || 0) + 1;
    document.getElementById('stats').innerHTML = Object.entries(counts).map(
      ([k, v]) => '<div class="stat"><div class="num">' + v + '</div><div class="label">' + k + '</div></div>'
    ).join('');
    const qEl = document.getElementById('queue');
    if (queue.length === 0) { qEl.innerHTML = '<div class="empty">No tasks</div>'; }
    else { qEl.innerHTML = queue.map(t =>
      '<div class="task-item"><span class="task-status ' + t.status + '"></span>' +
      '<span class="id">' + t.id + '</span><div class="question">' + t.question + '</div></div>'
    ).join(''); }
    const rEl = document.getElementById('reports');
    if (reports.length === 0) { rEl.innerHTML = '<div class="empty">No reports</div>'; }
    else { rEl.innerHTML = reports.map(r =>
      '<div class="report-item" onclick="loadReport(\\'' + r.name.replace(/'/g, "\\\\'") + '\\')">' +
      '<div class="name">' + r.name + '</div><div class="preview">' + (r.firstLine || '') + '</div></div>'
    ).join(''); }
    const eEl = document.getElementById('escalations');
    if (escalations.length === 0) { eEl.innerHTML = '<div class="empty">No escalations</div>'; }
    else { eEl.innerHTML = escalations.map(e =>
      '<div class="escalation-item"><div class="level">' + (e.level || 'unknown') + '</div>' +
      '<div class="msg">' + (e.message || e.name || '') + '</div></div>'
    ).join(''); }
  } catch (err) { console.error('Refresh failed:', err); }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

interface QueueItem {
  id: string;
  question: string;
  status: string;
  type: string;
  mode?: string;
}

interface ReportItem {
  name: string;
  firstLine: string;
}

interface EscalationItem {
  name: string;
  level: string;
  message: string;
}

export function startDashboard(config: Config, port = 3847): void {
  const llm = new LLM(config.llm.apiKey, config.llm.baseUrl);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (url.pathname === "/api/status") {
      const llmAvailable = await llm.isAvailable();
      respond(res, { llmAvailable });
      return;
    }

    if (url.pathname === "/api/queue") {
      const items: QueueItem[] = [];
      for (const status of ["running", "pending", "done", "failed", "escalated"] as const) {
        const tasks = loadTasks(config.paths.queue, status);
        for (const t of tasks) {
          items.push({ id: t.id, question: t.question, status, type: t.type, mode: t.mode });
        }
      }
      respond(res, items);
      return;
    }

    if (url.pathname === "/api/reports") {
      const items: ReportItem[] = [];
      if (existsSync(config.paths.reports)) {
        const files = readdirSync(config.paths.reports)
          .filter(f => f.endsWith(".md"))
          .sort()
          .reverse()
          .slice(0, 20);
        for (const f of files) {
          const content = readFileSync(resolve(config.paths.reports, f), "utf-8");
          items.push({ name: f, firstLine: content.split("\n")[0] ?? "" });
        }
      }
      respond(res, items);
      return;
    }

    if (url.pathname.startsWith("/api/reports/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/reports/".length));
      const filePath = resolve(config.paths.reports, name);
      if (existsSync(filePath) && !name.includes("..")) {
        respond(res, { name, content: readFileSync(filePath, "utf-8") });
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
      return;
    }

    if (url.pathname === "/api/escalations") {
      const items: EscalationItem[] = [];
      if (existsSync(config.paths.decisions)) {
        const files = readdirSync(config.paths.decisions)
          .filter(f => f.endsWith(".json"))
          .sort()
          .reverse()
          .slice(0, 20);
        for (const f of files) {
          try {
            const data = JSON.parse(readFileSync(resolve(config.paths.decisions, f), "utf-8")) as {
              level?: string;
              message?: string;
            };
            items.push({ name: f, level: data.level ?? "unknown", message: data.message ?? "" });
          } catch {
            items.push({ name: f, level: "unknown", message: "(parse error)" });
          }
        }
      }
      respond(res, items);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`[dashboard] EVE Monitor running at http://localhost:${port}`);
    console.log("[dashboard] Press Ctrl+C to stop");
  });
}

function respond(res: import("node:http").ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
