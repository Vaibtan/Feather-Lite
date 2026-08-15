from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, RedirectResponse

router = APIRouter(tags=["ui"], include_in_schema=False)


@router.get("/", response_class=RedirectResponse)
async def root_redirect() -> RedirectResponse:
    return RedirectResponse(url="/ui/conversations", status_code=307)


@router.get("/ui/conversations", response_class=HTMLResponse)
async def conversations_ui() -> HTMLResponse:
    return HTMLResponse(_CONVERSATIONS_HTML)


@router.get("/ui/scenarios", response_class=HTMLResponse)
async def scenarios_ui() -> HTMLResponse:
    return HTMLResponse(_SCENARIOS_HTML)


_CONVERSATIONS_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Feather-Lite Operator Console</title>
  <style>
    :root { color-scheme: light; --bg:#f4efe6; --ink:#1a1a1a; --card:#fffaf4; --line:#d3c4ae; --accent:#7d3f10; }
    body { margin:0; font-family: Georgia, 'Times New Roman', serif; background:linear-gradient(135deg,#f4efe6,#efe1cb); color:var(--ink); }
    header { padding:24px 28px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
    main { display:grid; grid-template-columns: 360px 1fr; gap:18px; padding:18px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; box-shadow:0 10px 30px rgba(73,45,19,.08); }
    button { background:var(--accent); color:white; border:none; border-radius:999px; padding:10px 16px; cursor:pointer; }
    ul { list-style:none; padding:0; margin:0; display:grid; gap:10px; }
    li { border:1px solid var(--line); border-radius:12px; padding:12px; cursor:pointer; }
    pre { white-space:pre-wrap; word-break:break-word; background:#f7f1e8; padding:12px; border-radius:12px; }
    .muted { color:#745d44; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 style="margin:0;">Feather-Lite Operator Console</h1>
      <p class="muted" style="margin:6px 0 0;">Inspect conversations, transcripts, and event timelines without touching the database.</p>
    </div>
    <a href="/ui/scenarios"><button>Scenario Runner</button></a>
  </header>
  <main>
    <section class="card">
      <h2>Conversations</h2>
      <ul id="conversation-list"></ul>
    </section>
    <section class="card">
      <h2>Detail</h2>
      <div id="detail" class="muted">Select a conversation to inspect it.</div>
    </section>
  </main>
  <script>
    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
    async function loadConversations() {
      const response = await fetch('/api/conversations');
      const conversations = await response.json();
      const list = document.getElementById('conversation-list');
      list.innerHTML = '';
      for (const item of conversations) {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${escapeHtml(item.borrower_name)}</strong><br><span class="muted">${escapeHtml(item.final_outcome || 'IN_PROGRESS')} · ${escapeHtml(item.channel)}</span>`;
        li.onclick = () => loadDetail(item.conversation_id);
        list.appendChild(li);
      }
    }
    async function loadDetail(conversationId) {
      const response = await fetch(`/api/conversations/${conversationId}`);
      const detail = await response.json();
      const transcript = detail.transcript
        .map(entry => `[${escapeHtml(entry.speaker)}] ${escapeHtml(entry.text)}`)
        .join('\\n');
      const timeline = detail.event_timeline
        .map(entry => `${escapeHtml(entry.type)} ${escapeHtml(JSON.stringify(entry.payload))}`)
        .join('\\n');
      document.getElementById('detail').innerHTML = `
        <p><strong>Conversation:</strong> ${escapeHtml(detail.conversation.id)}</p>
        <p><strong>Outcome:</strong> ${escapeHtml(detail.conversation.final_outcome || 'IN_PROGRESS')}</p>
        <h3>Transcript</h3>
        <pre>${transcript}</pre>
        <h3>Event Timeline</h3>
        <pre>${timeline}</pre>
      `;
    }
    loadConversations();
  </script>
</body>
</html>"""


_SCENARIOS_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Feather-Lite Scenario Runner</title>
  <style>
    :root { --bg:#fcf8f0; --ink:#101010; --accent:#0f5c4b; --line:#c7d7cf; }
    body { margin:0; font-family: 'Trebuchet MS', sans-serif; background:radial-gradient(circle at top,#fdfdf9,#ede7dc); color:var(--ink); }
    main { max-width:960px; margin:0 auto; padding:28px; }
    .row { display:flex; gap:12px; align-items:center; margin-bottom:12px; }
    select, button { padding:10px 14px; border-radius:10px; border:1px solid var(--line); }
    button { background:var(--accent); color:white; cursor:pointer; }
    pre { white-space:pre-wrap; word-break:break-word; background:white; border:1px solid var(--line); border-radius:16px; padding:16px; min-height:260px; }
  </style>
</head>
<body>
  <main>
    <h1>Scenario Runner</h1>
    <div class="row">
      <select id="scenario-select"></select>
      <button onclick="runScenario()">Run</button>
      <a href="/ui/conversations">Back to Conversations</a>
    </div>
    <pre id="result">Choose a scenario and run it.</pre>
  </main>
  <script>
    async function loadScenarios() {
      const response = await fetch('/api/testing/scenarios');
      const scenarios = await response.json();
      const select = document.getElementById('scenario-select');
      select.innerHTML = '';
      for (const item of scenarios) {
        const option = document.createElement('option');
        option.value = item.scenario_id;
        option.textContent = `${item.scenario_id} — ${item.description}`;
        select.appendChild(option);
      }
    }
    async function runScenario() {
      const scenarioId = document.getElementById('scenario-select').value;
      const response = await fetch(`/api/testing/scenarios/${scenarioId}/run`, { method: 'POST' });
      const result = await response.json();
      document.getElementById('result').textContent = JSON.stringify(result, null, 2);
    }
    loadScenarios();
  </script>
</body>
</html>"""
