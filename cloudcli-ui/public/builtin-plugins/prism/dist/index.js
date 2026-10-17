var h="'JetBrains Mono', 'Fira Code', ui-monospace, monospace",M=[["token_efficiency","token efficiency"],["tool_health","tool health"],["context_hygiene","context hygiene"],["claude_md_adherence","claude.md adherence"],["session_continuity","session continuity"]];function m(i){return i?{bg:"#08080f",surface:"#0e0e1a",border:"#1a1a2c",text:"#e2e0f0",muted:"#52507a",accent:"#fbbf24",dim:"rgba(251,191,36,0.1)"}:{bg:"#fafaf9",surface:"#ffffff",border:"#e8e6f0",text:"#0f0e1a",muted:"#9490b0",accent:"#d97706",dim:"rgba(217,119,6,0.08)"}}function y(i,n){switch(i.charAt(0)){case"A":return"#10b981";case"B":return"#22d3ee";case"C":return"#f59e0b";case"D":return"#fb923c";case"F":return"#f43f5e";default:return n.muted}}function L(i,n){switch(i.toLowerCase()){case"high":return"#f43f5e";case"medium":return"#f59e0b";default:return n.muted}}function l(i){return i.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function E(){if(document.getElementById("prism-styles"))return;let i=document.createElement("style");i.id="prism-styles",i.textContent=`
    @keyframes prism-grow   { from { width: 0 } }
    @keyframes prism-fadeup { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes prism-pulse  { 0%,100% { opacity:.3 } 50% { opacity:.6 } }
    .prism-bar  { animation: prism-grow   0.75s cubic-bezier(.16,1,.3,1) both }
    .prism-up   { animation: prism-fadeup 0.4s  ease both }
    .prism-skel { animation: prism-pulse  1.6s  ease infinite }
  `,document.head.appendChild(i)}function $(i,n){return n.map((s,c)=>`
    <div class="prism-skel" style="
      height:10px;width:${s}%;background:${i.muted};border-radius:2px;
      margin-bottom:8px;animation-delay:${c*.1}s
    "></div>`).join("")}function k(i,n){let s=y(i,n);return`
    <span style="
      display:inline-block;min-width:30px;text-align:center;
      padding:2px 7px;border:1px solid ${s};border-radius:3px;
      color:${s};font-size:0.7rem;font-weight:700;letter-spacing:0.04em;
    ">${l(i)}</span>`}function b(i,n,s,c){let o=Math.max(0,Math.min(100,Math.round(i)));return`
    <div style="flex:1;height:4px;background:${s.border};border-radius:1px;overflow:hidden">
      <div class="prism-bar" style="
        height:100%;width:${o}%;background:${y(n,s)};
        animation-delay:${c}s;border-radius:1px;
      "></div>
    </div>`}function R(i,n){E();let s=null,c=null,o=document.createElement("div");Object.assign(o.style,{height:"100%",overflowY:"auto",boxSizing:"border-box",padding:"24px",fontFamily:h}),i.appendChild(o);function w(r){let e=m(r.theme==="dark");o.style.background=e.bg,o.style.color=e.text,o.innerHTML=`
      <div class="prism-up" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60%;gap:16px">
        <pre style="font-size:0.75rem;color:${e.muted};opacity:0.6;line-height:1.6;text-align:center">$ prism
command not found</pre>
        <div style="font-size:0.72rem;color:${e.muted};letter-spacing:0.1em;text-transform:uppercase">prism is not installed</div>
        <div style="
          background:${e.surface};border:1px solid ${e.border};border-radius:3px;
          padding:12px 18px;font-size:0.78rem;color:${e.text};
        ">pip install prism-cc</div>
        <a href="https://github.com/jakeefr/prism" target="_blank" rel="noreferrer" style="
          font-size:0.7rem;color:${e.accent};text-decoration:none;
        ">github.com/jakeefr/prism \u2192</a>
      </div>`}function C(r,e){let t=m(r.theme==="dark");o.style.background=t.bg,o.innerHTML=`
      <div style="padding:24px;font-size:0.78rem;color:${t.accent};opacity:0.8;font-family:${h}">
        \u2717 ${l(e)}
      </div>`}function _(r){let e=m(r.theme==="dark");o.style.background=e.bg,o.style.color=e.text;let t=r.project?l(r.project.name):"all projects",d=r.project?l(r.project.path):"session health overview";o.innerHTML=`
      <div style="margin-bottom:24px">
        <div style="font-size:1.3rem;font-weight:700">${t}<span style="color:${e.accent}">\u258C</span></div>
        <div style="font-size:0.7rem;color:${e.muted};margin-top:4px">${d}</div>
      </div>
      <div style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
        ${$(e,[30,70,55,62,48,40])}
      </div>
      <div style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px">
        ${$(e,[80,65,50])}
      </div>`}function f(r,e,t,d){return`
      <div class="prism-up" style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px">
        <div style="min-width:0;flex:1">
          <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em;word-break:break-all">
            ${t}<span style="color:${e.accent}">\u258C</span>
          </div>
          <div style="font-size:0.7rem;color:${e.muted};margin-top:4px;word-break:break-all">${d}</div>
        </div>
        <button id="prism-refresh" style="
          flex-shrink:0;margin-left:16px;padding:5px 12px;
          background:transparent;border:1px solid ${e.border};
          color:${e.muted};font-family:${h};font-size:0.7rem;
          border-radius:3px;cursor:pointer;letter-spacing:0.05em;
          transition:all 0.15s;
        " onmouseover="this.style.borderColor='${e.accent}';this.style.color='${e.accent}'"
           onmouseout="this.style.borderColor='${e.border}';this.style.color='${e.muted}'">
          \u21BB refresh
        </button>
      </div>`}function j(r,e){let t=m(r.theme==="dark");o.style.background=t.bg,o.style.color=t.text;let d=y(e.overall_grade,t);o.innerHTML=`
      ${f(r,t,l(r.project?.name??e.display_name),l(r.project?.path??e.display_name))}

      <div class="prism-up" style="
        display:flex;align-items:center;gap:20px;
        background:${t.surface};border:1px solid ${t.border};
        border-radius:3px;padding:20px;margin-bottom:12px;
      ">
        <div style="
          font-size:2.6rem;font-weight:700;letter-spacing:-0.04em;line-height:1;
          color:${d};min-width:74px;text-align:center;
        ">${l(e.overall_grade)}</div>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:${t.muted};margin-bottom:8px">
            <span style="letter-spacing:0.1em;text-transform:uppercase">overall health</span>
            <span>${Number(e.overall_score).toFixed(1)} / 100 \xB7 ${Number(e.session_count)} session${e.session_count===1?"":"s"}${c?.version?` \xB7 prism v${l(c.version)}`:""}</span>
          </div>
          ${b(e.overall_score,e.overall_grade,t,.1)}
        </div>
      </div>

      <div class="prism-up" style="
        background:${t.surface};border:1px solid ${t.border};
        border-radius:3px;padding:18px;margin-bottom:12px;animation-delay:0.08s
      ">
        <div style="font-size:0.62rem;color:${t.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">dimensions</div>
        ${M.map(([a,p],x)=>{let g=e.dimensions[a];return g?`
          <div class="prism-up" style="display:flex;align-items:center;gap:12px;margin-bottom:9px;animation-delay:${.12+x*.04}s">
            <div style="width:160px;font-size:0.68rem;color:${t.muted};flex-shrink:0">${p}</div>
            ${b(g.score,g.grade,t,.15+x*.04)}
            <div style="width:42px;font-size:0.68rem;color:${t.muted};text-align:right;flex-shrink:0">${Number(g.score).toFixed(0)}</div>
            ${k(g.grade,t)}
          </div>`:""}).join("")}
      </div>

      <div class="prism-up" style="
        background:${t.surface};border:1px solid ${t.border};
        border-radius:3px;padding:18px;animation-delay:0.16s
      ">
        <div style="font-size:0.62rem;color:${t.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">top issues</div>
        ${e.top_issues.length===0?`<div style="font-size:0.72rem;color:${t.muted}">none found</div>`:e.top_issues.map((a,p)=>`
            <div class="prism-up" style="
              display:flex;gap:10px;align-items:baseline;
              padding:6px 0;border-bottom:1px solid ${t.border};font-size:0.7rem;
              animation-delay:${.2+p*.04}s;
            ">
              <span style="
                flex-shrink:0;font-size:0.6rem;font-weight:700;letter-spacing:0.08em;
                text-transform:uppercase;color:${L(a.severity,t)};
              ">${l(a.severity)}</span>
              <span style="flex-shrink:0;color:${t.muted}">${l(a.category)}</span>
              <span style="opacity:0.85">${l(a.description)}</span>
            </div>`).join("")}
      </div>
    `,o.querySelector("#prism-refresh")?.addEventListener("click",()=>{s=null,u(n.context)})}function z(r,e){let t=m(r.theme==="dark");o.style.background=t.bg,o.style.color=t.text;let d=[...e].sort((a,p)=>a.overall_score-p.overall_score);o.innerHTML=`
      ${f(r,t,"all projects","session health overview \xB7 select a project for the full report")}

      <div class="prism-up" style="
        background:${t.surface};border:1px solid ${t.border};
        border-radius:3px;padding:18px;animation-delay:0.06s
      ">
        <div style="font-size:0.62rem;color:${t.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">
          ${d.length} project${d.length===1?"":"s"} \xB7 worst first
        </div>
        ${d.length===0?`<div style="font-size:0.72rem;color:${t.muted}">no projects with session data found</div>`:d.map((a,p)=>`
          <div class="prism-up" style="display:flex;align-items:center;gap:12px;margin-bottom:9px;animation-delay:${.1+p*.03}s">
            <div style="
              flex:1;min-width:0;font-size:0.7rem;overflow:hidden;
              text-overflow:ellipsis;white-space:nowrap;opacity:0.85;
            " title="${l(a.display_name)}">${l(a.display_name)}</div>
            <div style="width:70px;font-size:0.66rem;color:${t.muted};text-align:right;flex-shrink:0">
              ${Number(a.session_count)} sess
            </div>
            <div style="width:120px;flex-shrink:0;display:flex">
              ${b(a.overall_score,a.overall_grade,t,.12+p*.03)}
            </div>
            <div style="width:42px;font-size:0.68rem;color:${t.muted};text-align:right;flex-shrink:0">${Number(a.overall_score).toFixed(0)}</div>
            ${k(a.overall_grade,t)}
          </div>`).join("")}
      </div>
    `,o.querySelector("#prism-refresh")?.addEventListener("click",()=>{s=null,u(n.context)})}function P(r){let e=m(r.theme==="dark");o.style.background=e.bg,o.style.color=e.text,o.innerHTML=`
      ${f(r,e,l(r.project?.name??"project"),l(r.project?.path??""))}
      <div class="prism-up" style="
        background:${e.surface};border:1px solid ${e.border};
        border-radius:3px;padding:28px 24px;text-align:center;animation-delay:0.06s
      ">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">no session data</div>
        <div style="font-size:0.74rem;color:${e.text};opacity:0.85;line-height:1.7">
          PRISM has no recorded Claude Code sessions for this project yet.<br>
          Run a session here, then hit refresh.
        </div>
      </div>`,o.querySelector("#prism-refresh")?.addEventListener("click",()=>{s=null,u(n.context)})}function v(r){s&&(s.projectPath?s.reports[0]?j(r,s.reports[0]):P(r):z(r,s.reports))}async function u(r){_(r);try{if(c||(c=await n.rpc("GET","health")),!c.installed){w(r);return}let e=r.project?.path??null,t=e?`report?path=${encodeURIComponent(e)}`:"report",{reports:d}=await n.rpc("GET",t);s={projectPath:e,reports:d},v(r)}catch(e){C(r,e.message)}}u(n.context);let T=n.onContextChange(r=>{let e=r.project?.path??null;s&&s.projectPath===e?v(r):u(r)});i._prismUnsubscribe=T}function H(i){typeof i._prismUnsubscribe=="function"&&(i._prismUnsubscribe(),delete i._prismUnsubscribe),i.innerHTML=""}export{R as mount,H as unmount};
