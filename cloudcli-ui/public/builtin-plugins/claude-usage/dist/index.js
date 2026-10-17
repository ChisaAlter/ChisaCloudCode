var f="'JetBrains Mono', 'Fira Code', ui-monospace, monospace";function h(e){return e?{bg:"#08080f",surface:"#0e0e1a",border:"#1a1a2c",text:"#e2e0f0",muted:"#52507a",accent:"#fbbf24",ok:"#10b981",warn:"#f59e0b",bad:"#f43f5e"}:{bg:"#fafaf9",surface:"#ffffff",border:"#e8e6f0",text:"#0f0e1a",muted:"#9490b0",accent:"#d97706",ok:"#059669",warn:"#d97706",bad:"#e11d48"}}function x(e,t,r){return r>=90||t!=="normal"&&t!=="warning"?e.bad:r>=70||t==="warning"?e.warn:e.ok}function p(e){return e<1e3?String(e):e<1e6?`${(e/1e3).toFixed(1)}K`:e<1e9?`${(e/1e6).toFixed(1)}M`:`${(e/1e9).toFixed(2)}B`}function g(e){return e===null?"\u2014":`$${e.toFixed(2)}`}function m(e){return e.input+e.output+e.cacheCreate+e.cacheRead}function $(e){if(!e)return"";let t=Date.parse(e)-Date.now();if(!Number.isFinite(t))return"";if(t<=0)return"resetting\u2026";let r=Math.floor(t/36e5),n=Math.floor(t%36e5/6e4);return r>=48?`resets in ${Math.floor(r/24)}d ${r%24}h`:r>0?`resets in ${r}h ${n}m`:`resets in ${n}m`}function c(e){return e.replace(/[&<>"]/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[t])}function u(e,t,r){return`
    <div style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
      <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">${t}</div>
      ${r}
    </div>`}function y(e,t){return`<div style="font-size:0.75rem;color:${e.warn};opacity:0.9">\u26A0 ${c(t)}</div>`}function k(e,t,r){let n=t?.plan?`<span style="font-size:0.62rem;border:1px solid ${e.border};border-radius:3px;padding:2px 8px;color:${e.muted}">${c(t.plan)}${t.tier?` \xB7 ${c(t.tier.replace(/^default_claude_/,""))}`:""}</span>`:"",o;return r?o=y(e,r):!t||t.limits.length===0?o=`<div style="font-size:0.75rem;color:${e.muted}">No limit data available.</div>`:o=t.limits.map(s=>{let i=x(e,s.severity,s.percent),l=Math.max(0,Math.min(100,s.percent));return`
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;margin-bottom:5px">
            <span>${c(s.label)}</span>
            <span style="color:${e.muted}">${s.percent}% \xB7 ${$(s.resetsAt)}</span>
          </div>
          <div style="height:6px;background:${e.border};border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${l}%;background:${i};border-radius:3px;transition:width 0.4s"></div>
          </div>
        </div>`}).join(""),u(e,`plan limits ${n}`,o)}function C(e,t){let r=Math.max(1,...t.map(o=>m(o.tokens)));return`<div style="display:flex;gap:2px;align-items:flex-end">${t.map((o,s)=>{let i=Math.round(m(o.tokens)/r*100);return`<div title="${`${o.date}: ${p(m(o.tokens))} tokens \xB7 ${g(o.cost)}`}" style="flex:1;display:flex;align-items:flex-end;height:90px">
      <div style="width:100%;height:${Math.max(i,m(o.tokens)>0?3:0)}%;background:${e.accent};opacity:${.45+.55*(s/t.length)};border-radius:1px"></div>
    </div>`}).join("")}</div>
    <div style="display:flex;justify-content:space-between;font-size:0.62rem;color:${e.muted};margin-top:6px">
      <span>${t[0]?.date??""}</span><span>${t[t.length-1]?.date??""}</span>
    </div>`}function b(e,t){return t.length===0?`<div style="font-size:0.75rem;color:${e.muted}">No data.</div>`:t.map(([r,n,o])=>`
    <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid ${e.border};font-size:0.72rem">
      <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;opacity:0.8" title="${c(r)}">${c(r)}</div>
      <div style="flex-shrink:0;color:${e.muted}">${p(m(n))}</div>
      <div style="flex-shrink:0;width:70px;text-align:right;color:${e.accent}">${g(o)}</div>
    </div>`).join("")}function w(e,t,r){if(r)return u(e,"usage history (30 days)",y(e,r));if(!t)return u(e,"usage history (30 days)",`<div style="font-size:0.75rem;color:${e.muted}">Loading\u2026</div>`);if(t.totals.messages===0)return u(e,"usage history (30 days)",`<div style="font-size:0.75rem;color:${e.muted}">No Claude Code activity found in the last 30 days.</div>`);let n=t.totals;return`
    ${`
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      ${[["total tokens",p(m(n.tokens))],["output tokens",p(n.tokens.output)],["est. cost",g(n.cost)],["sessions",String(n.sessions)]].map(([i,l])=>`
        <div style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:14px">
          <div style="font-size:1.35rem;font-weight:700;letter-spacing:-0.03em">${l}</div>
          <div style="font-size:0.62rem;color:${e.muted};margin-top:4px;letter-spacing:0.1em;text-transform:uppercase">${i}</div>
        </div>`).join("")}
    </div>`}
    ${u(e,"daily tokens (30 days)",C(e,t.daily))}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${u(e,"by model",b(e,t.byModel.map(i=>[i.model,i.tokens,i.cost])))}
      ${u(e,"by project",b(e,t.byProject.slice(0,10).map(i=>[i.project,i.tokens,i.cost])))}
    </div>`}function T(e,t){let r=document.createElement("div");Object.assign(r.style,{height:"100%",overflowY:"auto",boxSizing:"border-box",padding:"24px",fontFamily:f}),e.appendChild(r);let n={live:null,liveError:null,history:null,historyError:null};function o(a){let d=h(a.theme==="dark");r.style.background=d.bg,r.style.color=d.text,r.innerHTML=`
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:20px">
        <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em">Claude Usage<span style="color:${d.accent}">\u258C</span></div>
        <button id="cu-refresh" style="padding:5px 12px;background:transparent;border:1px solid ${d.border};color:${d.muted};font-family:${f};font-size:0.7rem;border-radius:3px;cursor:pointer">\u21BB refresh</button>
      </div>
      ${k(d,n.live,n.liveError)}
      ${w(d,n.history,n.historyError)}
    `,r.querySelector("#cu-refresh")?.addEventListener("click",()=>{l(!0)})}async function s(){try{n.live=await t.rpc("GET","live"),n.liveError=null}catch(a){n.live=null,n.liveError=a.message||"Live usage unavailable."}}async function i(){try{n.history=await t.rpc("GET","history?days=30"),n.historyError=null}catch(a){n.history=null,n.historyError=a.message||"History unavailable."}}async function l(a){await Promise.all([s(),a||!n.history?i():Promise.resolve()]),o(t.context)}o(t.context),l(!0);let v=t.onContextChange(a=>o(a));e._cuCleanup=()=>{v()}}function _(e){e._cuCleanup?.(),delete e._cuCleanup,e.innerHTML=""}export{T as mount,_ as unmount};
