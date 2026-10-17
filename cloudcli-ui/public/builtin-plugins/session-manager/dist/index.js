function A(o){return o?{bg:"#08080f",surface:"#0e0e1a",border:"#1a1a2c",text:"#e2e0f0",muted:"#52507a",accent:"#fbbf24",danger:"#f43f5e",ok:"#10b981",warn:"#f59e0b",dim:"rgba(251,191,36,0.08)",ctx:"#0b0b17"}:{bg:"#fafaf9",surface:"#ffffff",border:"#e8e6f0",text:"#0f0e1a",muted:"#9490b0",accent:"#d97706",danger:"#e11d48",ok:"#059669",warn:"#d97706",dim:"rgba(217,119,6,0.06)",ctx:"#f5f4f8"}}var f="'JetBrains Mono','Fira Code',ui-monospace,monospace";function y(o){let n="sm-styles",r=document.getElementById(n);r&&r.remove();let t=A(o),i=document.createElement("style");i.id=n,i.textContent=`
    .sm-wrap { font-family: ${f}; color: ${t.text}; padding: 16px; background: ${t.bg}; max-height: 100%; overflow-y: auto; }
    .sm-header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .sm-title { font-size: 14px; font-weight: 700; color: ${t.accent}; letter-spacing: .05em; text-transform: uppercase; }
    .sm-count { font-size: 11px; color: ${t.muted}; }
    .sm-refresh { background: ${t.surface}; border: 1px solid ${t.border}; color: ${t.muted}; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-family: ${f}; }
    .sm-refresh:hover { color: ${t.text}; border-color: ${t.accent}; }
    .sm-auto { display: flex; align-items: center; gap: 6px; font-size: 11px; color: ${t.muted}; margin-left: auto; }
    .sm-auto input { accent-color: ${t.accent}; cursor: pointer; }
    .sm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .sm-table th { text-align: left; padding: 6px 10px; color: ${t.muted}; font-weight: 600; border-bottom: 1px solid ${t.border}; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .sm-table td { padding: 8px 10px; border-bottom: 1px solid ${t.border}; vertical-align: middle; }
    .sm-row-main { cursor: pointer; }
    .sm-row-main:hover td { background: ${t.dim}; }
    .sm-row-main.sm-expanded td { background: ${t.dim}; }
    .sm-pid { color: ${t.muted}; font-size: 11px; white-space: nowrap; }
    .sm-chevron { display: inline-block; width: 12px; color: ${t.muted}; font-size: 9px; transition: transform .15s; }
    .sm-project { font-weight: 600; color: ${t.text}; }
    .sm-cwd { color: ${t.muted}; font-size: 10px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sm-user { color: ${t.muted}; font-size: 11px; }
    .sm-elapsed { color: ${t.muted}; font-size: 11px; }
    .sm-badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; }
    .sm-badge-stuck { background: rgba(244,63,94,.15); color: ${t.danger}; }
    .sm-badge-ok { background: rgba(16,185,129,.12); color: ${t.ok}; }
    .sm-badge-idle { background: rgba(148,144,176,.1); color: ${t.muted}; }
    .sm-actions { display: flex; gap: 6px; }
    .sm-btn { padding: 4px 10px; border-radius: 5px; font-size: 11px; font-family: ${f}; cursor: pointer; border: 1px solid transparent; font-weight: 600; transition: opacity .15s; }
    .sm-btn:hover { opacity: .8; }
    .sm-btn:disabled { opacity: .4; cursor: not-allowed; }
    .sm-kill { background: rgba(244,63,94,.15); border-color: ${t.danger}; color: ${t.danger}; }
    .sm-resume { background: rgba(16,185,129,.12); border-color: ${t.ok}; color: ${t.ok}; }
    .sm-cleanup-btn { background: rgba(148,144,176,.1); border: 1px solid ${t.border}; color: ${t.muted}; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-family: ${f}; font-weight: 600; }
    .sm-cleanup-btn:hover { border-color: ${t.accent}; color: ${t.accent}; }
    .sm-cleanup-btn:disabled { opacity: .4; cursor: not-allowed; }
    .sm-empty { text-align: center; padding: 40px; color: ${t.muted}; font-size: 12px; }
    .sm-ctx-row td { padding: 0; border-bottom: 1px solid ${t.border}; }
    .sm-ctx-inner { padding: 12px 20px 14px 32px; background: ${t.ctx}; border-top: 1px solid ${t.border}; }
    .sm-ctx-loading { font-size: 11px; color: ${t.muted}; font-style: italic; }
    .sm-ctx-section { margin-bottom: 10px; }
    .sm-ctx-section:last-child { margin-bottom: 0; }
    .sm-ctx-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: ${t.accent}; margin-bottom: 4px; }
    .sm-ctx-body { font-size: 11px; color: ${t.text}; white-space: pre-wrap; word-break: break-word; max-height: 100px; overflow-y: auto; line-height: 1.5; }
    .sm-ctx-none { font-size: 11px; color: ${t.muted}; font-style: italic; }
    .sm-toast { position: fixed; bottom: 20px; right: 20px; background: ${t.surface}; border: 1px solid ${t.border}; color: ${t.text}; padding: 10px 16px; border-radius: 8px; font-size: 12px; font-family: ${f}; z-index: 9999; box-shadow: 0 4px 20px rgba(0,0,0,.3); max-width: 360px; }
  `,document.head.appendChild(i)}function c(o,n=3500){let r=document.createElement("div");r.className="sm-toast",r.textContent=o,document.body.appendChild(r),setTimeout(()=>r.remove(),n)}function T(o,n){let r=[],t=!1,i=!0,x=null,b=n.context.theme==="dark",p=null,l=new Map;y(b),n.onContextChange(e=>{b=e.theme==="dark",y(b),m()});async function u(){if(!t){t=!0,I();try{r=await n.rpc("GET","/sessions")}catch(e){c("Failed to load sessions: "+e.message)}t=!1,m()}}async function w(e){if(!(l.has(e)&&l.get(e)!=="error")){l.set(e,"loading"),m();try{let s=await n.rpc("GET",`/sessions/${e}/context`);l.set(e,s)}catch{l.set(e,"error")}m()}}function v(e){p===e?(p=null,m()):(p=e,w(e))}async function k(e){try{await n.rpc("POST",`/sessions/${e}/kill`),c(`Sent SIGTERM to PID ${e}`),p===e&&(p=null),l.delete(e),setTimeout(u,1500)}catch(s){c("Kill failed: "+s.message)}}async function S(e){if(!e.sessionId||!e.cwd){c("No session ID or cwd available to resume");return}try{let s=await n.rpc("POST","/sessions/resume",{sessionId:e.sessionId,cwd:e.cwd,user:e.user});c(`Resumed session ${e.sessionId.slice(0,8)}... (PID ${s.pid})`),setTimeout(u,1500)}catch(s){c("Resume failed: "+s.message)}}async function C(){let e=o.querySelector("#sm-cleanup-btn");e&&(e.disabled=!0,e.textContent="Cleaning...");try{let s=await n.rpc("POST","/sessions/cleanup"),a=[];s.deletedSessions>0&&a.push(`${s.deletedSessions} orphaned session${s.deletedSessions!==1?"s":""} deleted`),s.compressedLogs>0&&a.push(`${s.compressedLogs} log${s.compressedLogs!==1?"s":""} compressed`),a.length===0&&a.push("nothing to clean up"),c("Cleanup: "+a.join(", ")),u()}catch(s){c("Cleanup failed: "+s.message)}finally{e&&(e.disabled=!1,e.textContent="Cleanup")}}function I(){o.querySelector(".sm-wrap")||m();let e=o.querySelector(".sm-tbody");e&&(e.innerHTML='<tr><td colspan="6" class="sm-empty">Refreshing...</td></tr>')}function z(e){return e.status==="stuck"?'<span class="sm-badge sm-badge-stuck">STUCK</span>':e.status==="idle"?'<span class="sm-badge sm-badge-idle">IDLE</span>':'<span class="sm-badge sm-badge-ok">ACTIVE</span>'}function E(e){let s=l.get(e.pid),a="";return!s||s==="loading"?a=`<span class="sm-ctx-loading">${s==="loading"?"Loading context...":""}</span>`:s==="error"?a='<span class="sm-ctx-none">Could not load session context</span>':s.lastPrompt||s.awaySummary||s.lastAssistant?(s.lastPrompt&&(a+=`<div class="sm-ctx-section">
            <div class="sm-ctx-label">Last Prompt</div>
            <div class="sm-ctx-body">${d(s.lastPrompt)}</div>
          </div>`),s.awaySummary&&(a+=`<div class="sm-ctx-section">
            <div class="sm-ctx-label">Away Summary</div>
            <div class="sm-ctx-body">${d(s.awaySummary)}</div>
          </div>`),s.lastAssistant&&(a+=`<div class="sm-ctx-section">
            <div class="sm-ctx-label">Last Claude Output</div>
            <div class="sm-ctx-body">${d(s.lastAssistant)}</div>
          </div>`)):a='<span class="sm-ctx-none">No context found in session log</span>',`<tr class="sm-ctx-row"><td colspan="6"><div class="sm-ctx-inner">${a}</div></td></tr>`}function L(e){let s=p===e.pid,a=`<span class="sm-chevron">${s?"\u25BC":"\u25B6"}</span>`,g=`
      <tr class="sm-row-main${s?" sm-expanded":""}" data-pid="${e.pid}">
        <td class="sm-pid">${a}${e.pid}</td>
        <td>
          <div class="sm-project">${d(e.project)}</div>
          <div class="sm-cwd" title="${d(e.cwd)}">${d(e.cwd)}</div>
          ${e.sessionId?`<div class="sm-cwd">${d(e.sessionId.slice(0,8))}...</div>`:""}
        </td>
        <td class="sm-user">${d(e.user)}</td>
        <td class="sm-elapsed">${d(e.elapsed)}</td>
        <td>${z(e)}</td>
        <td>
          <div class="sm-actions">
            <button class="sm-btn sm-kill" data-pid="${e.pid}">Kill</button>
            ${e.sessionId?`<button class="sm-btn sm-resume" data-resume='${JSON.stringify({sessionId:e.sessionId,cwd:e.cwd,user:e.user})}'>Resume</button>`:""}
          </div>
        </td>
      </tr>`;return s?g+E(e):g}function m(){o.innerHTML=`
      <div class="sm-wrap">
        <div class="sm-header">
          <span class="sm-title">Claude Sessions</span>
          <span class="sm-count">${r.length} process${r.length!==1?"es":""}</span>
          <button class="sm-refresh" id="sm-refresh-btn">Refresh</button>
          <button class="sm-cleanup-btn" id="sm-cleanup-btn">Cleanup</button>
          <label class="sm-auto">
            <input type="checkbox" id="sm-auto-cb" ${i?"checked":""}> Auto (10s)
          </label>
        </div>
        <table class="sm-table">
          <thead>
            <tr>
              <th>PID</th>
              <th>Project</th>
              <th>User</th>
              <th>Uptime</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody class="sm-tbody">
            ${r.length===0?`<tr><td colspan="6" class="sm-empty">${t?"Loading...":"No Claude sessions found"}</td></tr>`:r.map(L).join("")}
          </tbody>
        </table>
      </div>
    `,o.querySelector("#sm-refresh-btn")?.addEventListener("click",u),o.querySelector("#sm-cleanup-btn")?.addEventListener("click",C),o.querySelector("#sm-auto-cb")?.addEventListener("change",e=>{i=e.target.checked,i?h():$()}),o.querySelectorAll(".sm-row-main").forEach(e=>{e.addEventListener("click",s=>{s.target.closest(".sm-actions")||v(parseInt(e.dataset.pid,10))})}),o.querySelectorAll(".sm-kill").forEach(e=>{e.addEventListener("click",()=>k(parseInt(e.dataset.pid,10)))}),o.querySelectorAll(".sm-resume").forEach(e=>{e.addEventListener("click",()=>{try{S(JSON.parse(e.dataset.resume))}catch(s){c("Parse error: "+s.message)}})})}function d(e){return String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function h(){$(),x=setInterval(u,1e4)}function $(){x&&(clearInterval(x),x=null)}m(),u(),i&&h()}function P(o){o.innerHTML="";let n=document.getElementById("sm-styles");n&&n.remove()}export{T as mount,P as unmount};
