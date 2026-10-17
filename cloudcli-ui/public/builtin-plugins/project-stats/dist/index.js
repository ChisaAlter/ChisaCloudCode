var b=["#6366f1","#22d3ee","#f59e0b","#10b981","#f43f5e","#a78bfa","#fb923c","#34d399","#60a5fa","#e879f9","#facc15","#4ade80"],f="'JetBrains Mono', 'Fira Code', ui-monospace, monospace";function y(t){return t?{bg:"#08080f",surface:"#0e0e1a",border:"#1a1a2c",text:"#e2e0f0",muted:"#52507a",accent:"#fbbf24",dim:"rgba(251,191,36,0.1)"}:{bg:"#fafaf9",surface:"#ffffff",border:"#e8e6f0",text:"#0f0e1a",muted:"#9490b0",accent:"#d97706",dim:"rgba(217,119,6,0.08)"}}function j(){if(document.getElementById("ps-styles"))return;let t=document.createElement("style");t.id="ps-styles",t.textContent=`
    @keyframes ps-grow   { from { width: 0 } }
    @keyframes ps-fadeup { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes ps-pulse  { 0%,100% { opacity:.3 } 50% { opacity:.6 } }
    .ps-bar   { animation: ps-grow   0.75s cubic-bezier(.16,1,.3,1) both }
    .ps-up    { animation: ps-fadeup 0.4s  ease both }
    .ps-skel  { animation: ps-pulse  1.6s  ease infinite }
  `,document.head.appendChild(t)}function g(t){return t<1024?`${t}B`:t<1048576?`${(t/1024).toFixed(1)}KB`:`${(t/1048576).toFixed(1)}MB`}function w(t){let o=Math.floor((Date.now()-t)/1e3);return o<60?"just now":o<3600?`${Math.floor(o/60)}m ago`:o<86400?`${Math.floor(o/3600)}h ago`:`${Math.floor(o/86400)}d ago`}function z(t,o,d,s=900){let p=performance.now();function m(u){let n=Math.min((u-p)/s,1),i=1-(1-n)**3;t.textContent=d(Math.round(o*i)),n<1&&requestAnimationFrame(m)}requestAnimationFrame(m)}function x(t,o){return o.map((d,s)=>`
    <div class="ps-skel" style="
      height:10px;width:${d}%;background:${t.muted};border-radius:2px;
      margin-bottom:8px;animation-delay:${s*.1}s
    "></div>`).join("")}function C(t,o){j();let d=null,s=document.createElement("div");Object.assign(s.style,{height:"100%",overflowY:"auto",boxSizing:"border-box",padding:"24px",fontFamily:f}),t.appendChild(s);function p(n,i){let e=y(n.theme==="dark");if(s.style.background=e.bg,s.style.color=e.text,!n.project){s.innerHTML=`
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:50%;gap:14px">
          <pre style="font-size:0.75rem;color:${e.muted};opacity:0.5;line-height:1.6;text-align:center">~/.projects/
\u2514\u2500\u2500 (none selected)</pre>
          <div style="font-size:0.72rem;color:${e.muted};letter-spacing:0.1em;text-transform:uppercase">select a project</div>
        </div>`;return}if(!i){s.innerHTML=`
        <div style="margin-bottom:24px">
          <div style="font-size:1.3rem;font-weight:700">${n.project.name}<span style="color:${e.accent}">\u258C</span></div>
          <div style="font-size:0.7rem;color:${e.muted};margin-top:4px">${n.project.path}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
          ${[0,1,2].map(()=>`
            <div style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px">
              ${x(e,[65])}
              ${x(e,[40])}
            </div>`).join("")}
        </div>
        <div style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
          ${[75,55,38,22,14].map((r,a)=>`
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:7px">
              <div class="ps-skel" style="width:44px;height:8px;background:${e.muted};border-radius:2px;animation-delay:${a*.08}s"></div>
              <div class="ps-skel" style="width:${r}%;height:4px;background:${e.muted};border-radius:1px;animation-delay:${a*.08}s"></div>
            </div>`).join("")}
        </div>`;return}let v=i.byExtension[0]?.[1]||1;s.innerHTML=`
      <div class="ps-up" style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px">
        <div style="min-width:0;flex:1">
          <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em;word-break:break-all">
            ${n.project.name}<span style="color:${e.accent}">\u258C</span>
          </div>
          <div style="font-size:0.7rem;color:${e.muted};margin-top:4px;word-break:break-all">${n.project.path}</div>
        </div>
        <button id="ps-refresh" style="
          flex-shrink:0;margin-left:16px;padding:5px 12px;
          background:transparent;border:1px solid ${e.border};
          color:${e.muted};font-family:${f};font-size:0.7rem;
          border-radius:3px;cursor:pointer;letter-spacing:0.05em;
          transition:all 0.15s;
        " onmouseover="this.style.borderColor='${e.accent}';this.style.color='${e.accent}'"
           onmouseout="this.style.borderColor='${e.border}';this.style.color='${e.muted}'">
          \u21BB refresh
        </button>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
        ${[["files",i.totalFiles,r=>r.toLocaleString()],["lines",i.totalLines,r=>r.toLocaleString()],["total size",i.totalSize,g]].map(([r,,],a)=>`
          <div class="ps-up" style="
            background:${e.surface};border:1px solid ${e.border};
            border-radius:3px;padding:18px;animation-delay:${a*.06}s
          ">
            <div id="ps-m-${a}" style="
              font-size:1.9rem;font-weight:700;letter-spacing:-0.04em;
              line-height:1;color:${e.text};
            ">0</div>
            <div style="font-size:0.65rem;color:${e.muted};margin-top:6px;letter-spacing:0.1em;text-transform:uppercase">${r}</div>
          </div>`).join("")}
      </div>

      <div class="ps-up" style="
        background:${e.surface};border:1px solid ${e.border};
        border-radius:3px;padding:18px;margin-bottom:12px;animation-delay:0.12s
      ">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">file types</div>
        ${i.byExtension.map(([r,a],l)=>`
          <div class="ps-up" style="display:flex;align-items:center;gap:10px;margin-bottom:7px;animation-delay:${.15+l*.035}s">
            <div style="width:50px;font-size:0.68rem;text-align:right;color:${e.muted};flex-shrink:0">${r}</div>
            <div style="flex:1;height:4px;background:${e.border};border-radius:1px;overflow:hidden">
              <div class="ps-bar" style="
                height:100%;width:${Math.round(a/v*100)}%;
                background:${b[l%b.length]};
                animation-delay:${.18+l*.035}s;border-radius:1px;
              "></div>
            </div>
            <div style="width:30px;font-size:0.68rem;color:${e.muted};text-align:right;flex-shrink:0">${a}</div>
          </div>`).join("")}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${[["largest files",i.largest.map(r=>[r.name,g(r.size)])],["recently modified",i.recent.map(r=>[r.name,w(r.mtime)])]].map(([r,a],l)=>`
          <div class="ps-up" style="
            background:${e.surface};border:1px solid ${e.border};
            border-radius:3px;padding:18px;animation-delay:${.18+l*.05}s
          ">
            <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">${r}</div>
            ${a.map(([c,$],k)=>`
              <div class="ps-up" style="
                display:flex;justify-content:space-between;align-items:baseline;
                padding:4px 0;border-bottom:1px solid ${e.border};font-size:0.7rem;
                animation-delay:${.2+l*.05+k*.03}s;gap:8px;
              ">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;opacity:0.75" title="${c}">${c}</div>
                <div style="color:${e.accent};flex-shrink:0;opacity:0.9">${$}</div>
              </div>`).join("")}
          </div>`).join("")}
      </div>
    `;let h=[[0,i.totalFiles,r=>r.toLocaleString()],[1,i.totalLines,r=>r.toLocaleString()],[2,i.totalSize,g]];for(let[r,a,l]of h){let c=s.querySelector(`#ps-m-${r}`);c&&z(c,a,l)}s.querySelector("#ps-refresh")?.addEventListener("click",()=>{d=null,m(o.context)})}async function m(n){if(!n.project){d=null,p(n,null);return}p(n,null);try{let i=await o.rpc("GET",`stats?path=${encodeURIComponent(n.project.path)}`);d={projectPath:n.project.path,stats:i},p(n,i)}catch(i){let e=y(n.theme==="dark");s.style.background=e.bg,s.innerHTML=`
        <div style="padding:24px;font-size:0.78rem;color:${e.accent};opacity:0.8;font-family:${f}">
          \u2717 ${i.message}
        </div>`}}m(o.context);let u=o.onContextChange(n=>{n.project?.path===d?.projectPath?p(n,d?.stats??null):m(n)});t._psUnsubscribe=u}function M(t){typeof t._psUnsubscribe=="function"&&(t._psUnsubscribe(),delete t._psUnsubscribe),t.innerHTML=""}export{C as mount,M as unmount};
