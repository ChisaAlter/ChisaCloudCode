var y="'JetBrains Mono', 'Fira Code', ui-monospace, monospace",oe="tcc-state";var w=["#6366f1","#22d3ee","#f59e0b","#10b981","#f43f5e","#a78bfa","#fb923c","#34d399","#60a5fa","#e879f9","#facc15","#4ade80"];function ge(){try{let r=localStorage.getItem(oe);if(r){let s=JSON.parse(r);return["manual","auto","project","all","daily"].includes(s.mode)||(s.mode="manual"),s}}catch{}return{mode:"manual",inputPrice:3,outputPrice:15,cachedInputPrice:.3,inputTokens:1e6,outputTokens:1e5,cachedInputTokens:0}}function _(r){try{localStorage.setItem(oe,JSON.stringify(r))}catch{}}function xe(r){return r?{bg:"#08080f",surface:"#0e0e1a",border:"#1a1a2c",text:"#e2e0f0",muted:"#52507a",accent:"#6366f1",accentDim:"rgba(99,102,241,0.12)",green:"#10b981",greenDim:"rgba(16,185,129,0.12)",inputBg:"#0a0a14",warn:"#f59e0b"}:{bg:"#fafaf9",surface:"#ffffff",border:"#e8e6f0",text:"#0f0e1a",muted:"#9490b0",accent:"#4f46e5",accentDim:"rgba(79,70,229,0.08)",green:"#059669",greenDim:"rgba(5,150,105,0.08)",inputBg:"#f9f9fd",warn:"#d97706"}}function re(r){return r<.001?"$0.000":r<1?`$${r.toFixed(4)}`:`$${r.toFixed(3)}`}function k(r){return r.toLocaleString()}function ne(r,s,$){return Math.max(s,Math.min($,r))}function X(r){let s=Math.floor((Date.now()-r)/1e3);return s<5?"just now":s<60?`${s}s ago`:`${Math.floor(s/60)}m ago`}function ye(r,s){let $=s.inputTokens/1e6*r.inputPrice,o=s.outputTokens/1e6*r.outputPrice,u=s.cachedInputTokens/1e6*r.cachedInputPrice,g=$+o+u;return{inputCost:Math.round($*1e4)/1e4,outputCost:Math.round(o*1e4)/1e4,cachedInputCost:Math.round(u*1e4)/1e4,total:Math.round(g*1e4)/1e4}}function ke(r,s){$e();let $=[],o=ge(),u=null,g=null,l=null,a=null,b=new Date().toISOString().slice(0,10),T=0,f="",A=null,I="",m="",d=document.createElement("div");Object.assign(d.style,{height:"100%",overflowY:"auto",boxSizing:"border-box",padding:"24px",fontFamily:y}),r.appendChild(d);function x(t){let e=xe(t.theme==="dark");d.style.background=e.bg,d.style.color=e.text;let c=o.mode,i=c==="manual",p=c==="auto",C=c==="project",j=c==="all",S=c==="daily",v=i?{inputTokens:o.inputTokens,outputTokens:o.outputTokens,cachedInputTokens:o.cachedInputTokens}:p&&u?{inputTokens:u.inputTokens,outputTokens:u.outputTokens,cachedInputTokens:u.cachedInputTokens}:C&&g?{inputTokens:g.inputTokens,outputTokens:g.outputTokens,cachedInputTokens:g.cachedInputTokens}:j&&l?{inputTokens:l.inputTokens,outputTokens:l.outputTokens,cachedInputTokens:l.cachedInputTokens}:S&&a?(()=>{let n=a.days.find(h=>h.date===b);return n?{inputTokens:n.inputTokens,outputTokens:n.outputTokens,cachedInputTokens:n.cachedInputTokens}:{inputTokens:0,outputTokens:0,cachedInputTokens:0}})():{inputTokens:0,outputTokens:0,cachedInputTokens:0},N=ye({inputPrice:o.inputPrice,outputPrice:o.outputPrice,cachedInputPrice:o.cachedInputPrice},v),D=!!(t.session?.id&&t.project?.path),L=(n,h,P)=>`
      <button id="${n}" style="
        padding:5px 14px;font-family:${y};font-size:0.7rem;border-radius:3px;cursor:pointer;
        border:1px solid ${P?e.accent:e.border};
        background:${P?e.accentDim:"transparent"};
        color:${P?e.accent:e.muted};
        transition:all 0.15s;
      ">${h}</button>`,U="";if(p)U=D?`<span style="font-size:0.62rem;color:${e.green}">\u25CF monitoring session</span>`:`<span style="font-size:0.62rem;color:${e.warn}">\u26A0 no session context</span>`;else if(C&&g)U=`<span style="font-size:0.62rem;color:${e.green}">${g.sessionCount} sessions \xB7 ${g.turnCount} turns</span>`;else if(j&&l)U=`<span style="font-size:0.62rem;color:${e.green}">${l.projectCount} projects \xB7 ${l.sessionCount} sessions</span>`;else if(S&&a){let n=a.days.find(h=>h.date===b);U=`<span style="font-size:0.62rem;color:${e.green}">${a.days.length} days total${n?` \xB7 ${n.sessionCount}s \xB7 ${n.turnCount}t today`:""}</span>`}let fe=i?"Token Usage":p?"Token Usage (from session)":C?`Token Usage (${g?.sessionCount||0} sessions)`:j?`Token Usage (${l?.projectCount||0} projects, ${l?.sessionCount||0} sessions)`:`Token Usage \u2014 ${b}`;d.innerHTML=`
      <!-- Header -->
      <div class="tcc-header" style="margin-bottom:20px;display:flex;align-items:flex-start;justify-content:space-between">
        <div style="min-width:0;flex:1">
          <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em">
            Token Cost Calculator<span style="color:${e.accent}">\u258C</span>
          </div>
          <div style="font-size:0.7rem;color:${e.muted};margin-top:4px">Calculate API costs from token usage</div>
        </div>
      </div>

      <!-- \u2500\u2500 Mode switch \u2500\u2500 -->
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:10px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-right:4px">Mode</span>
          ${L("tcc-mode-manual","Manual",i)}
          ${L("tcc-mode-auto","Auto-detect",p)}
          ${L("tcc-mode-project","Project",C)}
          ${L("tcc-mode-all","All-time",j)}
          ${L("tcc-mode-daily","Daily",S)}
          ${U}
        </div>
      </div>

      <!-- \u2500\u2500 Project path input (Auto without session, or Project mode) \u2500\u2500 -->
      ${p&&!D||C?`
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:14px 18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">
          ${C?"Project Path":"Session Config"}
          <span style="text-transform:none;letter-spacing:0;color:${e.warn};margin-left:6px">(enter path manually)</span>
        </div>
        <div style="display:${p?"grid":"flex"};grid-template-columns:1fr 1fr;gap:10px;align-items:flex-end">
          <div style="flex:1">
            <label for="tcc-manual-project" style="display:block;font-size:0.6rem;color:${e.muted};margin-bottom:3px">Project Path</label>
            <input id="tcc-manual-project" type="text" value="${m}" placeholder="C:\\Users\\...\\my-project"
              style="width:100%;padding:6px 10px;background:${e.inputBg};border:1px solid ${e.border};
              color:${e.text};font-family:${y};font-size:0.7rem;border-radius:3px;
              outline:none;box-sizing:border-box;transition:border-color 0.15s"
              onfocus="this.style.borderColor='${e.accent}'" onblur="this.style.borderColor='${e.border}'">
          </div>
          ${p?`
          <div>
            <label for="tcc-manual-session" style="display:block;font-size:0.6rem;color:${e.muted};margin-bottom:3px">Session ID</label>
            <input id="tcc-manual-session" type="text" value="${I}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              style="width:100%;padding:6px 10px;background:${e.inputBg};border:1px solid ${e.border};
              color:${e.text};font-family:${y};font-size:0.7rem;border-radius:3px;
              outline:none;box-sizing:border-box;transition:border-color 0.15s"
              onfocus="this.style.borderColor='${e.accent}'" onblur="this.style.borderColor='${e.border}'">
          </div>`:""}
          <button id="${p?"tcc-connect-session":"tcc-fetch-project"}" style="
            padding:6px 14px;background:${e.accent};border:1px solid ${e.accent};
            color:#fff;font-family:${y};font-size:0.68rem;
            border-radius:3px;cursor:pointer;transition:all 0.15s;
            ${p?"":"white-space:nowrap;margin-left:10px;"}
          ">${p?"Connect":"Fetch"}</button>
        </div>
        ${f?`<div style="font-size:0.62rem;color:${e.warn};margin-top:8px">\u26A0 ${f}</div>`:""}
      </div>
      `:""}

      <!-- \u2500\u2500 Session info (auto mode with session) \u2500\u2500 -->
      ${p&&D?`
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:14px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:0.7rem;color:${e.text};font-weight:600">
              ${t.session?.title||"Session"} ${u?.turnCount?`\xB7 ${u.turnCount} turns`:""}
            </div>
            <div style="font-size:0.62rem;color:${e.muted};margin-top:2px">
              ${t.session?.id||"\u2014"} ${u?.model?`\xB7 model: ${u.model}`:""}
            </div>
            ${f?`<div style="font-size:0.62rem;color:${e.warn};margin-top:2px">\u26A0 ${f}</div>`:""}
          </div>
          <button id="tcc-refresh" style="
            padding:4px 12px;background:${e.accentDim};border:1px solid ${e.border};
            color:${e.accent};font-family:${y};font-size:0.68rem;
            border-radius:3px;cursor:pointer;transition:all 0.15s;
          ">\u21BB refresh ${T?`\xB7 ${X(T)}`:""}</button>
        </div>
      </div>
      `:""}

      <!-- \u2500\u2500 All-time summary info \u2500\u2500 -->
      ${j&&l?`
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:14px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:0.7rem;color:${e.text};font-weight:600">
              ${l.projectCount} projects \xB7 ${l.sessionCount} sessions \xB7 ${l.turnCount} turns
            </div>
            <div style="font-size:0.62rem;color:${e.muted};margin-top:2px">
              All Claude Code usage since install
            </div>
            ${f?`<div style="font-size:0.62rem;color:${e.warn};margin-top:2px">\u26A0 ${f}</div>`:""}
          </div>
          <button id="tcc-refresh" style="
            padding:4px 12px;background:${e.accentDim};border:1px solid ${e.border};
            color:${e.accent};font-family:${y};font-size:0.68rem;
            border-radius:3px;cursor:pointer;transition:all 0.15s;
          ">\u21BB refresh ${T?`\xB7 ${X(T)}`:""}</button>
        </div>
      </div>
      `:""}

      <!-- \u2500\u2500 Daily day navigator \u2500\u2500 -->
      ${S&&a?`
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:14px 18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <button id="tcc-day-prev" ${a.days.findIndex(n=>n.date===b)<=0?"disabled":""} style="
              padding:4px 8px;background:transparent;border:1px solid ${e.border};
              color:${e.text};font-family:${y};font-size:0.7rem;cursor:pointer;
              border-radius:3px;transition:all 0.15s;
              opacity:${a.days.findIndex(n=>n.date===b)<=0?"0.3":"1"};
            ">\u25C0</button>
            <span style="font-size:0.85rem;font-weight:600;color:${e.accent};min-width:90px;text-align:center">
              ${b}
            </span>
            <button id="tcc-day-next" ${a.days.findIndex(n=>n.date===b)>=a.days.length-1?"disabled":""} style="
              padding:4px 8px;background:transparent;border:1px solid ${e.border};
              color:${e.text};font-family:${y};font-size:0.7rem;cursor:pointer;
              border-radius:3px;transition:all 0.15s;
              opacity:${a.days.findIndex(n=>n.date===b)>=a.days.length-1?"0.3":"1"};
            ">\u25B6</button>
            <button id="tcc-day-today" ${!a.days.some(n=>n.date===new Date().toISOString().slice(0,10))||b===new Date().toISOString().slice(0,10)?"disabled":""} style="
              padding:4px 8px;background:transparent;border:1px solid ${e.accent};
              color:${e.accent};font-family:${y};font-size:0.62rem;cursor:pointer;
              border-radius:3px;transition:all 0.15s;
              opacity:${!a.days.some(n=>n.date===new Date().toISOString().slice(0,10))||b===new Date().toISOString().slice(0,10)?"0.3":"1"};
            ">\u25CF today</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:0.62rem;color:${e.muted}">${a.days[0]?.date||"\u2014"} ~ ${a.days[a.days.length-1]?.date||"\u2014"}</span>
            <button id="tcc-refresh" style="
              padding:4px 12px;background:${e.accentDim};border:1px solid ${e.border};
              color:${e.accent};font-family:${y};font-size:0.68rem;
              border-radius:3px;cursor:pointer;transition:all 0.15s;
            ">\u21BB ${T?X(T):"refresh"}</button>
          </div>
        </div>
        ${f?`<div style="font-size:0.62rem;color:${e.warn};margin-top:8px">\u26A0 ${f}</div>`:""}
      </div>
      `:""}

      <!-- \u2500\u2500 Model Preset Selector \u2500\u2500 -->
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">Model Preset</div>
        <select id="tcc-preset" style="
          width:100%;padding:8px 12px;background:${e.inputBg};border:1px solid ${e.border};
          color:${e.text};font-family:${y};font-size:0.78rem;border-radius:3px;
          cursor:pointer;outline:none;
        ">
          <option value="">-- Custom --</option>
          ${$.map(n=>`<option value="${n.name}">${n.name} (${n.provider})</option>`).join("")}
        </select>
      </div>

      <!-- \u2500\u2500 Price Inputs \u2500\u2500 -->
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">Price per 1M Tokens (USD)</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
          ${Z("tcc-input-price","Input Price",o.inputPrice,e)}
          ${Z("tcc-output-price","Output Price",o.outputPrice,e)}
          ${Z("tcc-cached-price","Cache Input Price",o.cachedInputPrice,e)}
        </div>
      </div>

      <!-- \u2500\u2500 Token Usage \u2500\u2500 -->
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase">${fe}</div>
          ${i?"":`<div style="font-size:0.62rem;color:${e.muted}">${k(v.inputTokens+v.outputTokens+v.cachedInputTokens)} total</div>`}
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
          ${ee("tcc-input-tokens","Input Tokens",v.inputTokens,!i,e)}
          ${ee("tcc-output-tokens","Output Tokens",v.outputTokens,!i,e)}
          ${ee("tcc-cached-tokens","Cached Input Tokens",v.cachedInputTokens,!i,e)}
        </div>
      </div>

      <!-- \u2500\u2500 Quick-add buttons (manual only) \u2500\u2500 -->
      ${i?`
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:14px">Quick Add Tokens</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${[1e3,1e4,1e5,1e6,1e7].map(n=>`<button class="tcc-quick-btn" data-tokens="${n}" style="
              padding:4px 10px;background:${e.accentDim};border:1px solid ${e.border};
              color:${e.accent};font-family:${y};font-size:0.68rem;
              border-radius:3px;cursor:pointer;transition:all 0.15s;
            ">+${n>=1e6?n/1e6+"M":n>=1e3?n/1e3+"K":n}</button>`).join("")}
          <span style="font-size:0.62rem;color:${e.muted};display:flex;align-items:center;margin-left:6px">\u2192 active field</span>
        </div>
      </div>
      `:""}

      <!-- \u2500\u2500 Per-session breakdown (Project mode) \u2500\u2500 -->
      ${C&&g&&g.sessions.length>0?`
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">Per-Session Breakdown</div>
        <div style="max-height:260px;overflow-y:auto">
          ${g.sessions.map((n,h)=>`
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid ${e.border};font-size:0.68rem;gap:8px">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:${e.text};opacity:0.75" title="${n.sessionId}">
                ${n.sessionId.slice(0,8)}... ${n.turnCount}t \xB7 ${n.model}
              </div>
              <div style="flex-shrink:0;color:${e.muted}">
                <span style="color:${e.accent}">${k(n.inputTokens)}</span> in
                \xB7 ${k(n.outputTokens)} out
                ${n.cachedInputTokens>0?`\xB7 ${k(n.cachedInputTokens)} cache`:""}
              </div>
            </div>
          `).join("")}
        </div>
      </div>
      `:""}

      <!-- \u2500\u2500 Per-project breakdown (All-time mode) \u2500\u2500 -->
      ${j&&l&&l.projects.length>0?`
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">Per-Project Breakdown</div>
        <div style="max-height:300px;overflow-y:auto">
          ${l.projects.map((n,h)=>{let P=n.inputTokens+n.outputTokens+n.cachedInputTokens,K=l.projects[0]?l.projects[0].inputTokens+l.projects[0].outputTokens+l.projects[0].cachedInputTokens:1,W=Math.round(P/Math.max(1,K)*100);return`
            <div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:0.68rem;margin-bottom:3px">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:${e.text};opacity:0.8" title="${n.projectPath}">
                  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${w[h%w.length]};margin-right:6px;vertical-align:middle"></span>${n.projectPath.split(/[\\/]/).pop()||n.projectPath}
                </div>
                <div style="flex-shrink:0;color:${e.muted};margin-left:8px">
                  ${k(P)} tok \xB7 ${n.sessionCount} sessions \xB7 ${n.turnCount}t
                </div>
              </div>
              <div style="height:3px;background:${e.border};border-radius:1px;overflow:hidden">
                <div style="height:100%;width:${W}%;background:${w[h%w.length]};border-radius:1px"></div>
              </div>
            </div>`}).join("")}
        </div>
      </div>
      `:""}

      <!-- \u2500\u2500 Per-day breakdown (Daily mode) \u2500\u2500 -->
      ${S&&a&&a.days.length>0?`
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px;margin-bottom:12px">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:12px">Per-Day Breakdown</div>
        <div style="max-height:300px;overflow-y:auto">
          ${a.days.map((n,h)=>{let P=n.inputTokens+n.outputTokens+n.cachedInputTokens,K=a.days.reduce((be,V)=>Math.max(be,V.inputTokens+V.outputTokens+V.cachedInputTokens),1),W=Math.round(P/Math.max(1,K)*100),E=n.date===b;return`
            <div data-tcc-day="${n.date}" style="margin-bottom:8px;cursor:pointer;padding:4px 6px;border-radius:3px;
              background:${E?e.accentDim:"transparent"};
              border:1px solid ${E?e.accent:"transparent"};
              transition:background 0.15s;
            ">
              <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:0.68rem;margin-bottom:3px">
                <div style="color:${E?e.accent:e.text};opacity:${E?1:.8};font-weight:${E?600:400}">
                  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${w[h%w.length]};margin-right:6px;vertical-align:middle"></span>${n.date}${E?" \u25C0":""}
                </div>
                <div style="flex-shrink:0;color:${e.muted};margin-left:8px">
                  ${k(P)} tok \xB7 ${n.sessionCount} sessions \xB7 ${n.turnCount}t
                </div>
              </div>
              <div style="height:3px;background:${e.border};border-radius:1px;overflow-hidden">
                <div style="height:100%;width:${W}%;background:${w[h%w.length]};border-radius:1px"></div>
              </div>
            </div>`}).join("")}
        </div>
      </div>
      `:""}

      <!-- \u2500\u2500 Cost Breakdown \u2500\u2500 -->
      <div class="tcc-section" style="background:${e.surface};border:1px solid ${e.border};border-radius:3px;padding:18px">
        <div style="font-size:0.62rem;color:${e.muted};letter-spacing:0.12em;text-transform:uppercase;margin-bottom:16px">Cost Breakdown${S?` \u2014 ${b}`:""}</div>

        <div style="display:flex;flex-direction:column;gap:10px">
          ${te("Input",N.inputCost,v.inputTokens,e)}
          ${te("Output",N.outputCost,v.outputTokens,e)}
          ${te("Cached input",N.cachedInputCost,v.cachedInputTokens,e)}
        </div>

        <div style="margin-top:14px;padding-top:14px;border-top:2px solid ${e.border}">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <div style="font-size:0.75rem;font-weight:700;color:${e.text}">Total Cost</div>
            <div id="tcc-total" style="font-size:1.5rem;font-weight:700;color:${e.green};letter-spacing:-0.03em">${re(N.total)}</div>
          </div>
          <div style="font-size:0.62rem;color:${e.muted};margin-top:4px;text-align:right">
            ${k(v.inputTokens+v.outputTokens+v.cachedInputTokens)} total tokens
          </div>
        </div>
      </div>
    `,se(t),ce(t),de(t),i&&le(t),i&&ue(),p&&D&&G(t),C&&ae(),j&&G(t),S&&a&&(G(t),pe()),p&&!D&&ie(t)}function M(t,e){o.mode!==t&&(o.mode=t,Q(),_(o),u=null,g=null,l=null,a=null,b=new Date().toISOString().slice(0,10),f="",t==="auto"?e.session?.id&&e.project?.path&&(I="",m="",z(e),B(e)):t==="project"?(!m&&e.project?.path&&(m=e.project.path),m&&q()):t==="all"?Y():t==="daily"&&J(),x(e))}function se(t){d.querySelector("#tcc-mode-manual")?.addEventListener("click",()=>M("manual",t)),d.querySelector("#tcc-mode-auto")?.addEventListener("click",()=>M("auto",t)),d.querySelector("#tcc-mode-project")?.addEventListener("click",()=>M("project",t)),d.querySelector("#tcc-mode-all")?.addEventListener("click",()=>M("all",t)),d.querySelector("#tcc-mode-daily")?.addEventListener("click",()=>M("daily",t))}function ie(t){d.querySelector("#tcc-connect-session")?.addEventListener("click",()=>{let e=d.querySelector("#tcc-manual-project"),c=d.querySelector("#tcc-manual-session");if(e&&(m=e.value.trim()),c&&(I=c.value.trim()),!m||!I){f="Please enter both Project Path and Session ID",x(t);return}f="",u=null;let i={...t,project:{name:m.split(/[\\/]/).pop()||m,path:m},session:{id:I,title:"Manual Session"}};z(i),B(t)})}function ae(){d.querySelector("#tcc-fetch-project")?.addEventListener("click",()=>{let t=d.querySelector("#tcc-manual-project");if(t&&(m=t.value.trim()),!m){f="Please enter a Project Path",x(s.context);return}q()})}function ce(t){d.querySelector("#tcc-preset")?.addEventListener("change",e=>{let c=e.target.value,i=$.find(p=>p.name===c);i&&(o.inputPrice=i.inputPrice,o.outputPrice=i.outputPrice,o.cachedInputPrice=i.cachedInputPrice,_(o),x(t))})}function de(t){H("#tcc-input-price",e=>{o.inputPrice=e}),H("#tcc-output-price",e=>{o.outputPrice=e}),H("#tcc-cached-price",e=>{o.cachedInputPrice=e})}function H(t,e){let c=d.querySelector(t);c&&(c.addEventListener("input",()=>{let i=parseFloat(c.value);!isNaN(i)&&i>=0&&e(ne(i,0,999))}),c.addEventListener("change",()=>{_(o),x(s.context)}))}function le(t){R("#tcc-input-tokens",e=>{o.inputTokens=e}),R("#tcc-output-tokens",e=>{o.outputTokens=e}),R("#tcc-cached-tokens",e=>{o.cachedInputTokens=e})}function R(t,e){let c=d.querySelector(t);c&&(c.addEventListener("input",()=>{let i=c.value.replace(/[^0-9]/g,""),p=parseInt(i,10);!isNaN(p)&&p>=0&&e(p)}),c.addEventListener("change",()=>{_(o),x(s.context)}),c.addEventListener("blur",()=>{let i=parseInt(c.value.replace(/[^0-9]/g,""),10);isNaN(i)||(c.value=k(i))}))}let O="input";function ue(){d.querySelectorAll("input[data-tcc-field]").forEach(t=>{t.addEventListener("focus",()=>{O=t.dataset.tccField})}),d.querySelectorAll(".tcc-quick-btn").forEach(t=>{t.addEventListener("click",()=>{let e=parseInt(t.dataset.tokens||"0",10);O==="input"?o.inputTokens+=e:O==="output"?o.outputTokens+=e:o.cachedInputTokens+=e,_(o),x(s.context)})})}function F(t){return t.session?.id&&t.project?.path?t:m&&I?{...t,project:{name:m.split(/[\\/]/).pop()||m,path:m},session:{id:I,title:"Manual Session"}}:t}function G(t){d.querySelector("#tcc-refresh")?.addEventListener("click",()=>{o.mode==="auto"?z(F(t)):o.mode==="project"?q():o.mode==="all"?Y():o.mode==="daily"&&J()})}function pe(){d.querySelector("#tcc-day-prev")?.addEventListener("click",()=>{if(!a)return;let t=a.days.findIndex(e=>e.date===b);t>0&&(b=a.days[t-1].date,x(s.context))}),d.querySelector("#tcc-day-next")?.addEventListener("click",()=>{if(!a)return;let t=a.days.findIndex(e=>e.date===b);t<a.days.length-1&&(b=a.days[t+1].date,x(s.context))}),d.querySelector("#tcc-day-today")?.addEventListener("click",()=>{if(!a)return;let t=new Date().toISOString().slice(0,10);a.days.some(e=>e.date===t)&&(b=t,x(s.context))}),d.querySelectorAll("[data-tcc-day]").forEach(t=>{t.addEventListener("click",()=>{let e=t.dataset.tccDay;e&&(b=e,x(s.context))})})}async function z(t){if(!(!t.project?.path||!t.session?.id)){try{u=await s.rpc("GET",`session-usage?projectPath=${encodeURIComponent(t.project.path)}&sessionId=${encodeURIComponent(t.session.id)}`),f=u.error||"",T=Date.now()}catch(e){f=e.message||"fetch failed"}x(t)}}async function q(){if(m){try{g=await s.rpc("GET",`project-usage?projectPath=${encodeURIComponent(m)}`),f=g.error||"",T=Date.now()}catch(t){f=t.message||"fetch failed"}x(s.context)}}async function Y(){try{l=await s.rpc("GET","all-usage"),f=l.error||"",T=Date.now()}catch(t){f=t.message||"fetch failed"}x(s.context)}async function J(){try{a=await s.rpc("GET","daily-usage"),f=a.error||"",T=Date.now()}catch(t){f=t.message||"fetch failed"}x(s.context)}function B(t){Q(),A=setInterval(()=>{o.mode==="auto"&&z(F(t))},3e4)}function Q(){A&&(clearInterval(A),A=null)}function ve(t,e){let c=d.querySelector(t);c&&c.addEventListener("input",()=>{let i=parseFloat(c.value);!isNaN(i)&&i>=0&&e(ne(i,0,999))})}function he(t,e){let c=d.querySelector(t);c&&(c.addEventListener("input",()=>{let i=c.value.replace(/[^0-9]/g,""),p=parseInt(i,10);!isNaN(p)&&p>=0&&e(p)}),c.addEventListener("blur",()=>{let i=parseInt(c.value.replace(/[^0-9]/g,""),10);isNaN(i)||(c.value=k(i))}))}if(x(s.context),s.rpc("GET","presets").then(t=>{$=t,x(s.context)}).catch(()=>{}),o.mode==="auto"){let t=F(s.context);t.session?.id&&t.project?.path&&(z(t),B(s.context))}else o.mode==="project"?(!m&&s.context.project?.path&&(m=s.context.project.path),m&&q()):o.mode==="all"?Y():o.mode==="daily"&&J();let me=s.onContextChange(t=>{t.project?.path&&(m=t.project.path,I=t.session?.id||""),o.mode==="auto"&&t.session?.id&&t.project?.path&&(u=null,f="",z(t),B(t)),x(t)});r._tccUnsubscribe=me,r._tccStopRefresh=Q}function Te(r){typeof r._tccUnsubscribe=="function"&&(r._tccUnsubscribe(),delete r._tccUnsubscribe),typeof r._tccStopRefresh=="function"&&(r._tccStopRefresh(),delete r._tccStopRefresh),r.innerHTML=""}function Z(r,s,$,o){return`
    <div>
      <label for="${r}" style="display:block;font-size:0.65rem;color:${o.muted};margin-bottom:4px">${s}</label>
      <div style="position:relative">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:${o.muted};font-size:0.72rem">$</span>
        <input id="${r}" type="number" value="${$}" step="0.001" min="0" max="999"
          style="width:100%;padding:8px 10px 8px 22px;background:${o.inputBg};border:1px solid ${o.border};
          color:${o.text};font-family:${y};font-size:0.78rem;border-radius:3px;
          outline:none;box-sizing:border-box;transition:border-color 0.15s"
          onfocus="this.style.borderColor='${o.accent}'" onblur="this.style.borderColor='${o.border}'">
        <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:${o.muted};font-size:0.6rem">/1M</span>
      </div>
    </div>`}function ee(r,s,$,o,u){let g=o?"readonly":"",l=o?"opacity:0.85;cursor:default;":"";return`
    <div>
      <label for="${r}" style="display:block;font-size:0.65rem;color:${u.muted};margin-bottom:4px">${s}</label>
      <input id="${r}" type="text" data-tcc-field="${r.includes("output")?"output":r.includes("cached")?"cached":"input"}"
        value="${k($)}" ${g}
        style="width:100%;padding:8px 10px;background:${u.inputBg};border:1px solid ${u.border};
        color:${u.text};font-family:${y};font-size:0.78rem;border-radius:3px;
        outline:none;box-sizing:border-box;transition:border-color 0.15s;${l}"
        onfocus="this.style.borderColor='${u.accent}'" onblur="this.style.borderColor='${u.border}'">
    </div>`}function te(r,s,$,o){return`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid ${o.border}">
      <div>
        <div style="font-size:0.7rem;color:${o.text};opacity:0.8">${r}</div>
        <div style="font-size:0.6rem;color:${o.muted};margin-top:2px">${k($)} tokens</div>
      </div>
      <div style="font-size:0.85rem;font-weight:600;color:${o.text}">${re(s)}</div>
    </div>`}function $e(){if(document.getElementById("tcc-styles"))return;let r=document.createElement("style");r.id="tcc-styles",r.textContent=`
    @keyframes tcc-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: translateY(0) } }
    .tcc-section { animation: tcc-fadein 0.25s ease both; }
    .tcc-section:nth-child(2) { animation-delay: 0.03s; }
    .tcc-section:nth-child(3) { animation-delay: 0.06s; }
    .tcc-section:nth-child(4) { animation-delay: 0.09s; }
    .tcc-section:nth-child(5) { animation-delay: 0.12s; }
    .tcc-section:nth-child(6) { animation-delay: 0.15s; }
    .tcc-section:nth-child(7) { animation-delay: 0.18s; }
    .tcc-section:nth-child(8) { animation-delay: 0.21s; }
  `,document.head.appendChild(r)}export{ke as mount,Te as unmount};
