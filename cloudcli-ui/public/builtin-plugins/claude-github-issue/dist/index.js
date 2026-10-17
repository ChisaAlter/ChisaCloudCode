var Ip=Object.create;var aa=Object.defineProperty;var Rp=Object.getOwnPropertyDescriptor;var Tp=Object.getOwnPropertyNames;var Lp=Object.getPrototypeOf,Mp=Object.prototype.hasOwnProperty;var Ct=(e,t)=>()=>{try{return t||e((t={exports:{}}).exports,t),t.exports}catch(n){throw t=0,n}};var Dp=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of Tp(t))!Mp.call(e,o)&&o!==n&&aa(e,o,{get:()=>t[o],enumerable:!(r=Rp(t,o))||r.enumerable});return e};var T=(e,t,n)=>(n=e!=null?Ip(Lp(e)):{},Dp(t||!e||!e.__esModule?aa(n,"default",{value:e,enumerable:!0}):n,e));var wa=Ct(j=>{"use strict";var tr=Symbol.for("react.element"),Op=Symbol.for("react.portal"),Ap=Symbol.for("react.fragment"),Fp=Symbol.for("react.strict_mode"),jp=Symbol.for("react.profiler"),$p=Symbol.for("react.provider"),Up=Symbol.for("react.context"),Hp=Symbol.for("react.forward_ref"),Bp=Symbol.for("react.suspense"),Wp=Symbol.for("react.memo"),Vp=Symbol.for("react.lazy"),ua=Symbol.iterator;function Gp(e){return e===null||typeof e!="object"?null:(e=ua&&e[ua]||e["@@iterator"],typeof e=="function"?e:null)}var pa={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},fa=Object.assign,ga={};function En(e,t,n){this.props=e,this.context=t,this.refs=ga,this.updater=n||pa}En.prototype.isReactComponent={};En.prototype.setState=function(e,t){if(typeof e!="object"&&typeof e!="function"&&e!=null)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,t,"setState")};En.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};function ma(){}ma.prototype=En.prototype;function Ai(e,t,n){this.props=e,this.context=t,this.refs=ga,this.updater=n||pa}var Fi=Ai.prototype=new ma;Fi.constructor=Ai;fa(Fi,En.prototype);Fi.isPureReactComponent=!0;var ca=Array.isArray,ha=Object.prototype.hasOwnProperty,ji={current:null},va={key:!0,ref:!0,__self:!0,__source:!0};function ya(e,t,n){var r,o={},i=null,l=null;if(t!=null)for(r in t.ref!==void 0&&(l=t.ref),t.key!==void 0&&(i=""+t.key),t)ha.call(t,r)&&!va.hasOwnProperty(r)&&(o[r]=t[r]);var s=arguments.length-2;if(s===1)o.children=n;else if(1<s){for(var a=Array(s),c=0;c<s;c++)a[c]=arguments[c+2];o.children=a}if(e&&e.defaultProps)for(r in s=e.defaultProps,s)o[r]===void 0&&(o[r]=s[r]);return{$$typeof:tr,type:e,key:i,ref:l,props:o,_owner:ji.current}}function Qp(e,t){return{$$typeof:tr,type:e.type,key:t,ref:e.ref,props:e.props,_owner:e._owner}}function $i(e){return typeof e=="object"&&e!==null&&e.$$typeof===tr}function Kp(e){var t={"=":"=0",":":"=2"};return"$"+e.replace(/[=:]/g,function(n){return t[n]})}var da=/\/+/g;function Oi(e,t){return typeof e=="object"&&e!==null&&e.key!=null?Kp(""+e.key):t.toString(36)}function no(e,t,n,r,o){var i=typeof e;(i==="undefined"||i==="boolean")&&(e=null);var l=!1;if(e===null)l=!0;else switch(i){case"string":case"number":l=!0;break;case"object":switch(e.$$typeof){case tr:case Op:l=!0}}if(l)return l=e,o=o(l),e=r===""?"."+Oi(l,0):r,ca(o)?(n="",e!=null&&(n=e.replace(da,"$&/")+"/"),no(o,t,n,"",function(c){return c})):o!=null&&($i(o)&&(o=Qp(o,n+(!o.key||l&&l.key===o.key?"":(""+o.key).replace(da,"$&/")+"/")+e)),t.push(o)),1;if(l=0,r=r===""?".":r+":",ca(e))for(var s=0;s<e.length;s++){i=e[s];var a=r+Oi(i,s);l+=no(i,t,n,a,o)}else if(a=Gp(e),typeof a=="function")for(e=a.call(e),s=0;!(i=e.next()).done;)i=i.value,a=r+Oi(i,s++),l+=no(i,t,n,a,o);else if(i==="object")throw t=String(e),Error("Objects are not valid as a React child (found: "+(t==="[object Object]"?"object with keys {"+Object.keys(e).join(", ")+"}":t)+"). If you meant to render a collection of children, use an array instead.");return l}function to(e,t,n){if(e==null)return e;var r=[],o=0;return no(e,r,"","",function(i){return t.call(n,i,o++)}),r}function Yp(e){if(e._status===-1){var t=e._result;t=t(),t.then(function(n){(e._status===0||e._status===-1)&&(e._status=1,e._result=n)},function(n){(e._status===0||e._status===-1)&&(e._status=2,e._result=n)}),e._status===-1&&(e._status=0,e._result=t)}if(e._status===1)return e._result.default;throw e._result}var Me={current:null},ro={transition:null},Xp={ReactCurrentDispatcher:Me,ReactCurrentBatchConfig:ro,ReactCurrentOwner:ji};function xa(){throw Error("act(...) is not supported in production builds of React.")}j.Children={map:to,forEach:function(e,t,n){to(e,function(){t.apply(this,arguments)},n)},count:function(e){var t=0;return to(e,function(){t++}),t},toArray:function(e){return to(e,function(t){return t})||[]},only:function(e){if(!$i(e))throw Error("React.Children.only expected to receive a single React element child.");return e}};j.Component=En;j.Fragment=Ap;j.Profiler=jp;j.PureComponent=Ai;j.StrictMode=Fp;j.Suspense=Bp;j.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=Xp;j.act=xa;j.cloneElement=function(e,t,n){if(e==null)throw Error("React.cloneElement(...): The argument must be a React element, but you passed "+e+".");var r=fa({},e.props),o=e.key,i=e.ref,l=e._owner;if(t!=null){if(t.ref!==void 0&&(i=t.ref,l=ji.current),t.key!==void 0&&(o=""+t.key),e.type&&e.type.defaultProps)var s=e.type.defaultProps;for(a in t)ha.call(t,a)&&!va.hasOwnProperty(a)&&(r[a]=t[a]===void 0&&s!==void 0?s[a]:t[a])}var a=arguments.length-2;if(a===1)r.children=n;else if(1<a){s=Array(a);for(var c=0;c<a;c++)s[c]=arguments[c+2];r.children=s}return{$$typeof:tr,type:e.type,key:o,ref:i,props:r,_owner:l}};j.createContext=function(e){return e={$$typeof:Up,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},e.Provider={$$typeof:$p,_context:e},e.Consumer=e};j.createElement=ya;j.createFactory=function(e){var t=ya.bind(null,e);return t.type=e,t};j.createRef=function(){return{current:null}};j.forwardRef=function(e){return{$$typeof:Hp,render:e}};j.isValidElement=$i;j.lazy=function(e){return{$$typeof:Vp,_payload:{_status:-1,_result:e},_init:Yp}};j.memo=function(e,t){return{$$typeof:Wp,type:e,compare:t===void 0?null:t}};j.startTransition=function(e){var t=ro.transition;ro.transition={};try{e()}finally{ro.transition=t}};j.unstable_act=xa;j.useCallback=function(e,t){return Me.current.useCallback(e,t)};j.useContext=function(e){return Me.current.useContext(e)};j.useDebugValue=function(){};j.useDeferredValue=function(e){return Me.current.useDeferredValue(e)};j.useEffect=function(e,t){return Me.current.useEffect(e,t)};j.useId=function(){return Me.current.useId()};j.useImperativeHandle=function(e,t,n){return Me.current.useImperativeHandle(e,t,n)};j.useInsertionEffect=function(e,t){return Me.current.useInsertionEffect(e,t)};j.useLayoutEffect=function(e,t){return Me.current.useLayoutEffect(e,t)};j.useMemo=function(e,t){return Me.current.useMemo(e,t)};j.useReducer=function(e,t,n){return Me.current.useReducer(e,t,n)};j.useRef=function(e){return Me.current.useRef(e)};j.useState=function(e){return Me.current.useState(e)};j.useSyncExternalStore=function(e,t,n){return Me.current.useSyncExternalStore(e,t,n)};j.useTransition=function(){return Me.current.useTransition()};j.version="18.3.1"});var Ne=Ct((Lm,ka)=>{"use strict";ka.exports=wa()});var Ra=Ct(K=>{"use strict";function Wi(e,t){var n=e.length;e.push(t);e:for(;0<n;){var r=n-1>>>1,o=e[r];if(0<oo(o,t))e[r]=t,e[n]=o,n=r;else break e}}function st(e){return e.length===0?null:e[0]}function lo(e){if(e.length===0)return null;var t=e[0],n=e.pop();if(n!==t){e[0]=n;e:for(var r=0,o=e.length,i=o>>>1;r<i;){var l=2*(r+1)-1,s=e[l],a=l+1,c=e[a];if(0>oo(s,n))a<o&&0>oo(c,s)?(e[r]=c,e[a]=n,r=a):(e[r]=s,e[l]=n,r=l);else if(a<o&&0>oo(c,n))e[r]=c,e[a]=n,r=a;else break e}}return t}function oo(e,t){var n=e.sortIndex-t.sortIndex;return n!==0?n:e.id-t.id}typeof performance=="object"&&typeof performance.now=="function"?(Sa=performance,K.unstable_now=function(){return Sa.now()}):(Ui=Date,ba=Ui.now(),K.unstable_now=function(){return Ui.now()-ba});var Sa,Ui,ba,mt=[],Ut=[],Zp=1,Ze=null,Pe=3,so=!1,un=!1,rr=!1,Na=typeof setTimeout=="function"?setTimeout:null,Pa=typeof clearTimeout=="function"?clearTimeout:null,Ca=typeof setImmediate<"u"?setImmediate:null;typeof navigator<"u"&&navigator.scheduling!==void 0&&navigator.scheduling.isInputPending!==void 0&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function Vi(e){for(var t=st(Ut);t!==null;){if(t.callback===null)lo(Ut);else if(t.startTime<=e)lo(Ut),t.sortIndex=t.expirationTime,Wi(mt,t);else break;t=st(Ut)}}function Gi(e){if(rr=!1,Vi(e),!un)if(st(mt)!==null)un=!0,Ki(Qi);else{var t=st(Ut);t!==null&&Yi(Gi,t.startTime-e)}}function Qi(e,t){un=!1,rr&&(rr=!1,Pa(or),or=-1),so=!0;var n=Pe;try{for(Vi(t),Ze=st(mt);Ze!==null&&(!(Ze.expirationTime>t)||e&&!Ia());){var r=Ze.callback;if(typeof r=="function"){Ze.callback=null,Pe=Ze.priorityLevel;var o=r(Ze.expirationTime<=t);t=K.unstable_now(),typeof o=="function"?Ze.callback=o:Ze===st(mt)&&lo(mt),Vi(t)}else lo(mt);Ze=st(mt)}if(Ze!==null)var i=!0;else{var l=st(Ut);l!==null&&Yi(Gi,l.startTime-t),i=!1}return i}finally{Ze=null,Pe=n,so=!1}}var ao=!1,io=null,or=-1,za=5,_a=-1;function Ia(){return!(K.unstable_now()-_a<za)}function Hi(){if(io!==null){var e=K.unstable_now();_a=e;var t=!0;try{t=io(!0,e)}finally{t?nr():(ao=!1,io=null)}}else ao=!1}var nr;typeof Ca=="function"?nr=function(){Ca(Hi)}:typeof MessageChannel<"u"?(Bi=new MessageChannel,Ea=Bi.port2,Bi.port1.onmessage=Hi,nr=function(){Ea.postMessage(null)}):nr=function(){Na(Hi,0)};var Bi,Ea;function Ki(e){io=e,ao||(ao=!0,nr())}function Yi(e,t){or=Na(function(){e(K.unstable_now())},t)}K.unstable_IdlePriority=5;K.unstable_ImmediatePriority=1;K.unstable_LowPriority=4;K.unstable_NormalPriority=3;K.unstable_Profiling=null;K.unstable_UserBlockingPriority=2;K.unstable_cancelCallback=function(e){e.callback=null};K.unstable_continueExecution=function(){un||so||(un=!0,Ki(Qi))};K.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):za=0<e?Math.floor(1e3/e):5};K.unstable_getCurrentPriorityLevel=function(){return Pe};K.unstable_getFirstCallbackNode=function(){return st(mt)};K.unstable_next=function(e){switch(Pe){case 1:case 2:case 3:var t=3;break;default:t=Pe}var n=Pe;Pe=t;try{return e()}finally{Pe=n}};K.unstable_pauseExecution=function(){};K.unstable_requestPaint=function(){};K.unstable_runWithPriority=function(e,t){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var n=Pe;Pe=e;try{return t()}finally{Pe=n}};K.unstable_scheduleCallback=function(e,t,n){var r=K.unstable_now();switch(typeof n=="object"&&n!==null?(n=n.delay,n=typeof n=="number"&&0<n?r+n:r):n=r,e){case 1:var o=-1;break;case 2:o=250;break;case 5:o=1073741823;break;case 4:o=1e4;break;default:o=5e3}return o=n+o,e={id:Zp++,callback:t,priorityLevel:e,startTime:n,expirationTime:o,sortIndex:-1},n>r?(e.sortIndex=n,Wi(Ut,e),st(mt)===null&&e===st(Ut)&&(rr?(Pa(or),or=-1):rr=!0,Yi(Gi,n-r))):(e.sortIndex=o,Wi(mt,e),un||so||(un=!0,Ki(Qi))),e};K.unstable_shouldYield=Ia;K.unstable_wrapCallback=function(e){var t=Pe;return function(){var n=Pe;Pe=t;try{return e.apply(this,arguments)}finally{Pe=n}}}});var La=Ct((Dm,Ta)=>{"use strict";Ta.exports=Ra()});var Ad=Ct(Ye=>{"use strict";var Jp=Ne(),Qe=La();function w(e){for(var t="https://reactjs.org/docs/error-decoder.html?invariant="+e,n=1;n<arguments.length;n++)t+="&args[]="+encodeURIComponent(arguments[n]);return"Minified React error #"+e+"; visit "+t+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}var $u=new Set,Nr={};function Sn(e,t){Gn(e,t),Gn(e+"Capture",t)}function Gn(e,t){for(Nr[e]=t,e=0;e<t.length;e++)$u.add(t[e])}var It=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),yl=Object.prototype.hasOwnProperty,qp=/^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/,Ma={},Da={};function ef(e){return yl.call(Da,e)?!0:yl.call(Ma,e)?!1:qp.test(e)?Da[e]=!0:(Ma[e]=!0,!1)}function tf(e,t,n,r){if(n!==null&&n.type===0)return!1;switch(typeof t){case"function":case"symbol":return!0;case"boolean":return r?!1:n!==null?!n.acceptsBooleans:(e=e.toLowerCase().slice(0,5),e!=="data-"&&e!=="aria-");default:return!1}}function nf(e,t,n,r){if(t===null||typeof t>"u"||tf(e,t,n,r))return!0;if(r)return!1;if(n!==null)switch(n.type){case 3:return!t;case 4:return t===!1;case 5:return isNaN(t);case 6:return isNaN(t)||1>t}return!1}function Ae(e,t,n,r,o,i,l){this.acceptsBooleans=t===2||t===3||t===4,this.attributeName=r,this.attributeNamespace=o,this.mustUseProperty=n,this.propertyName=e,this.type=t,this.sanitizeURL=i,this.removeEmptyString=l}var Se={};"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e){Se[e]=new Ae(e,0,!1,e,null,!1,!1)});[["acceptCharset","accept-charset"],["className","class"],["htmlFor","for"],["httpEquiv","http-equiv"]].forEach(function(e){var t=e[0];Se[t]=new Ae(t,1,!1,e[1],null,!1,!1)});["contentEditable","draggable","spellCheck","value"].forEach(function(e){Se[e]=new Ae(e,2,!1,e.toLowerCase(),null,!1,!1)});["autoReverse","externalResourcesRequired","focusable","preserveAlpha"].forEach(function(e){Se[e]=new Ae(e,2,!1,e,null,!1,!1)});"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e){Se[e]=new Ae(e,3,!1,e.toLowerCase(),null,!1,!1)});["checked","multiple","muted","selected"].forEach(function(e){Se[e]=new Ae(e,3,!0,e,null,!1,!1)});["capture","download"].forEach(function(e){Se[e]=new Ae(e,4,!1,e,null,!1,!1)});["cols","rows","size","span"].forEach(function(e){Se[e]=new Ae(e,6,!1,e,null,!1,!1)});["rowSpan","start"].forEach(function(e){Se[e]=new Ae(e,5,!1,e.toLowerCase(),null,!1,!1)});var cs=/[\-:]([a-z])/g;function ds(e){return e[1].toUpperCase()}"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e){var t=e.replace(cs,ds);Se[t]=new Ae(t,1,!1,e,null,!1,!1)});"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e){var t=e.replace(cs,ds);Se[t]=new Ae(t,1,!1,e,"http://www.w3.org/1999/xlink",!1,!1)});["xml:base","xml:lang","xml:space"].forEach(function(e){var t=e.replace(cs,ds);Se[t]=new Ae(t,1,!1,e,"http://www.w3.org/XML/1998/namespace",!1,!1)});["tabIndex","crossOrigin"].forEach(function(e){Se[e]=new Ae(e,1,!1,e.toLowerCase(),null,!1,!1)});Se.xlinkHref=new Ae("xlinkHref",1,!1,"xlink:href","http://www.w3.org/1999/xlink",!0,!1);["src","href","action","formAction"].forEach(function(e){Se[e]=new Ae(e,1,!1,e.toLowerCase(),null,!0,!0)});function ps(e,t,n,r){var o=Se.hasOwnProperty(t)?Se[t]:null;(o!==null?o.type!==0:r||!(2<t.length)||t[0]!=="o"&&t[0]!=="O"||t[1]!=="n"&&t[1]!=="N")&&(nf(t,n,o,r)&&(n=null),r||o===null?ef(t)&&(n===null?e.removeAttribute(t):e.setAttribute(t,""+n)):o.mustUseProperty?e[o.propertyName]=n===null?o.type===3?!1:"":n:(t=o.attributeName,r=o.attributeNamespace,n===null?e.removeAttribute(t):(o=o.type,n=o===3||o===4&&n===!0?"":""+n,r?e.setAttributeNS(r,t,n):e.setAttribute(t,n))))}var Mt=Jp.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,uo=Symbol.for("react.element"),zn=Symbol.for("react.portal"),_n=Symbol.for("react.fragment"),fs=Symbol.for("react.strict_mode"),xl=Symbol.for("react.profiler"),Uu=Symbol.for("react.provider"),Hu=Symbol.for("react.context"),gs=Symbol.for("react.forward_ref"),wl=Symbol.for("react.suspense"),kl=Symbol.for("react.suspense_list"),ms=Symbol.for("react.memo"),Bt=Symbol.for("react.lazy"),Bu=Symbol.for("react.offscreen"),Oa=Symbol.iterator;function ir(e){return e===null||typeof e!="object"?null:(e=Oa&&e[Oa]||e["@@iterator"],typeof e=="function"?e:null)}var re=Object.assign,Xi;function fr(e){if(Xi===void 0)try{throw Error()}catch(n){var t=n.stack.trim().match(/\n( *(at )?)/);Xi=t&&t[1]||""}return`
`+Xi+e}var Zi=!1;function Ji(e,t){if(!e||Zi)return"";Zi=!0;var n=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(t)if(t=function(){throw Error()},Object.defineProperty(t.prototype,"props",{set:function(){throw Error()}}),typeof Reflect=="object"&&Reflect.construct){try{Reflect.construct(t,[])}catch(c){var r=c}Reflect.construct(e,[],t)}else{try{t.call()}catch(c){r=c}e.call(t.prototype)}else{try{throw Error()}catch(c){r=c}e()}}catch(c){if(c&&r&&typeof c.stack=="string"){for(var o=c.stack.split(`
`),i=r.stack.split(`
`),l=o.length-1,s=i.length-1;1<=l&&0<=s&&o[l]!==i[s];)s--;for(;1<=l&&0<=s;l--,s--)if(o[l]!==i[s]){if(l!==1||s!==1)do if(l--,s--,0>s||o[l]!==i[s]){var a=`
`+o[l].replace(" at new "," at ");return e.displayName&&a.includes("<anonymous>")&&(a=a.replace("<anonymous>",e.displayName)),a}while(1<=l&&0<=s);break}}}finally{Zi=!1,Error.prepareStackTrace=n}return(e=e?e.displayName||e.name:"")?fr(e):""}function rf(e){switch(e.tag){case 5:return fr(e.type);case 16:return fr("Lazy");case 13:return fr("Suspense");case 19:return fr("SuspenseList");case 0:case 2:case 15:return e=Ji(e.type,!1),e;case 11:return e=Ji(e.type.render,!1),e;case 1:return e=Ji(e.type,!0),e;default:return""}}function Sl(e){if(e==null)return null;if(typeof e=="function")return e.displayName||e.name||null;if(typeof e=="string")return e;switch(e){case _n:return"Fragment";case zn:return"Portal";case xl:return"Profiler";case fs:return"StrictMode";case wl:return"Suspense";case kl:return"SuspenseList"}if(typeof e=="object")switch(e.$$typeof){case Hu:return(e.displayName||"Context")+".Consumer";case Uu:return(e._context.displayName||"Context")+".Provider";case gs:var t=e.render;return e=e.displayName,e||(e=t.displayName||t.name||"",e=e!==""?"ForwardRef("+e+")":"ForwardRef"),e;case ms:return t=e.displayName||null,t!==null?t:Sl(e.type)||"Memo";case Bt:t=e._payload,e=e._init;try{return Sl(e(t))}catch{}}return null}function of(e){var t=e.type;switch(e.tag){case 24:return"Cache";case 9:return(t.displayName||"Context")+".Consumer";case 10:return(t._context.displayName||"Context")+".Provider";case 18:return"DehydratedFragment";case 11:return e=t.render,e=e.displayName||e.name||"",t.displayName||(e!==""?"ForwardRef("+e+")":"ForwardRef");case 7:return"Fragment";case 5:return t;case 4:return"Portal";case 3:return"Root";case 6:return"Text";case 16:return Sl(t);case 8:return t===fs?"StrictMode":"Mode";case 22:return"Offscreen";case 12:return"Profiler";case 21:return"Scope";case 13:return"Suspense";case 19:return"SuspenseList";case 25:return"TracingMarker";case 1:case 0:case 17:case 2:case 14:case 15:if(typeof t=="function")return t.displayName||t.name||null;if(typeof t=="string")return t}return null}function rn(e){switch(typeof e){case"boolean":case"number":case"string":case"undefined":return e;case"object":return e;default:return""}}function Wu(e){var t=e.type;return(e=e.nodeName)&&e.toLowerCase()==="input"&&(t==="checkbox"||t==="radio")}function lf(e){var t=Wu(e)?"checked":"value",n=Object.getOwnPropertyDescriptor(e.constructor.prototype,t),r=""+e[t];if(!e.hasOwnProperty(t)&&typeof n<"u"&&typeof n.get=="function"&&typeof n.set=="function"){var o=n.get,i=n.set;return Object.defineProperty(e,t,{configurable:!0,get:function(){return o.call(this)},set:function(l){r=""+l,i.call(this,l)}}),Object.defineProperty(e,t,{enumerable:n.enumerable}),{getValue:function(){return r},setValue:function(l){r=""+l},stopTracking:function(){e._valueTracker=null,delete e[t]}}}}function co(e){e._valueTracker||(e._valueTracker=lf(e))}function Vu(e){if(!e)return!1;var t=e._valueTracker;if(!t)return!0;var n=t.getValue(),r="";return e&&(r=Wu(e)?e.checked?"true":"false":e.value),e=r,e!==n?(t.setValue(e),!0):!1}function jo(e){if(e=e||(typeof document<"u"?document:void 0),typeof e>"u")return null;try{return e.activeElement||e.body}catch{return e.body}}function bl(e,t){var n=t.checked;return re({},t,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:n??e._wrapperState.initialChecked})}function Aa(e,t){var n=t.defaultValue==null?"":t.defaultValue,r=t.checked!=null?t.checked:t.defaultChecked;n=rn(t.value!=null?t.value:n),e._wrapperState={initialChecked:r,initialValue:n,controlled:t.type==="checkbox"||t.type==="radio"?t.checked!=null:t.value!=null}}function Gu(e,t){t=t.checked,t!=null&&ps(e,"checked",t,!1)}function Cl(e,t){Gu(e,t);var n=rn(t.value),r=t.type;if(n!=null)r==="number"?(n===0&&e.value===""||e.value!=n)&&(e.value=""+n):e.value!==""+n&&(e.value=""+n);else if(r==="submit"||r==="reset"){e.removeAttribute("value");return}t.hasOwnProperty("value")?El(e,t.type,n):t.hasOwnProperty("defaultValue")&&El(e,t.type,rn(t.defaultValue)),t.checked==null&&t.defaultChecked!=null&&(e.defaultChecked=!!t.defaultChecked)}function Fa(e,t,n){if(t.hasOwnProperty("value")||t.hasOwnProperty("defaultValue")){var r=t.type;if(!(r!=="submit"&&r!=="reset"||t.value!==void 0&&t.value!==null))return;t=""+e._wrapperState.initialValue,n||t===e.value||(e.value=t),e.defaultValue=t}n=e.name,n!==""&&(e.name=""),e.defaultChecked=!!e._wrapperState.initialChecked,n!==""&&(e.name=n)}function El(e,t,n){(t!=="number"||jo(e.ownerDocument)!==e)&&(n==null?e.defaultValue=""+e._wrapperState.initialValue:e.defaultValue!==""+n&&(e.defaultValue=""+n))}var gr=Array.isArray;function $n(e,t,n,r){if(e=e.options,t){t={};for(var o=0;o<n.length;o++)t["$"+n[o]]=!0;for(n=0;n<e.length;n++)o=t.hasOwnProperty("$"+e[n].value),e[n].selected!==o&&(e[n].selected=o),o&&r&&(e[n].defaultSelected=!0)}else{for(n=""+rn(n),t=null,o=0;o<e.length;o++){if(e[o].value===n){e[o].selected=!0,r&&(e[o].defaultSelected=!0);return}t!==null||e[o].disabled||(t=e[o])}t!==null&&(t.selected=!0)}}function Nl(e,t){if(t.dangerouslySetInnerHTML!=null)throw Error(w(91));return re({},t,{value:void 0,defaultValue:void 0,children:""+e._wrapperState.initialValue})}function ja(e,t){var n=t.value;if(n==null){if(n=t.children,t=t.defaultValue,n!=null){if(t!=null)throw Error(w(92));if(gr(n)){if(1<n.length)throw Error(w(93));n=n[0]}t=n}t==null&&(t=""),n=t}e._wrapperState={initialValue:rn(n)}}function Qu(e,t){var n=rn(t.value),r=rn(t.defaultValue);n!=null&&(n=""+n,n!==e.value&&(e.value=n),t.defaultValue==null&&e.defaultValue!==n&&(e.defaultValue=n)),r!=null&&(e.defaultValue=""+r)}function $a(e){var t=e.textContent;t===e._wrapperState.initialValue&&t!==""&&t!==null&&(e.value=t)}function Ku(e){switch(e){case"svg":return"http://www.w3.org/2000/svg";case"math":return"http://www.w3.org/1998/Math/MathML";default:return"http://www.w3.org/1999/xhtml"}}function Pl(e,t){return e==null||e==="http://www.w3.org/1999/xhtml"?Ku(t):e==="http://www.w3.org/2000/svg"&&t==="foreignObject"?"http://www.w3.org/1999/xhtml":e}var po,Yu=(function(e){return typeof MSApp<"u"&&MSApp.execUnsafeLocalFunction?function(t,n,r,o){MSApp.execUnsafeLocalFunction(function(){return e(t,n,r,o)})}:e})(function(e,t){if(e.namespaceURI!=="http://www.w3.org/2000/svg"||"innerHTML"in e)e.innerHTML=t;else{for(po=po||document.createElement("div"),po.innerHTML="<svg>"+t.valueOf().toString()+"</svg>",t=po.firstChild;e.firstChild;)e.removeChild(e.firstChild);for(;t.firstChild;)e.appendChild(t.firstChild)}});function Pr(e,t){if(t){var n=e.firstChild;if(n&&n===e.lastChild&&n.nodeType===3){n.nodeValue=t;return}}e.textContent=t}var vr={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},sf=["Webkit","ms","Moz","O"];Object.keys(vr).forEach(function(e){sf.forEach(function(t){t=t+e.charAt(0).toUpperCase()+e.substring(1),vr[t]=vr[e]})});function Xu(e,t,n){return t==null||typeof t=="boolean"||t===""?"":n||typeof t!="number"||t===0||vr.hasOwnProperty(e)&&vr[e]?(""+t).trim():t+"px"}function Zu(e,t){e=e.style;for(var n in t)if(t.hasOwnProperty(n)){var r=n.indexOf("--")===0,o=Xu(n,t[n],r);n==="float"&&(n="cssFloat"),r?e.setProperty(n,o):e[n]=o}}var af=re({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});function zl(e,t){if(t){if(af[e]&&(t.children!=null||t.dangerouslySetInnerHTML!=null))throw Error(w(137,e));if(t.dangerouslySetInnerHTML!=null){if(t.children!=null)throw Error(w(60));if(typeof t.dangerouslySetInnerHTML!="object"||!("__html"in t.dangerouslySetInnerHTML))throw Error(w(61))}if(t.style!=null&&typeof t.style!="object")throw Error(w(62))}}function _l(e,t){if(e.indexOf("-")===-1)return typeof t.is=="string";switch(e){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}var Il=null;function hs(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}var Rl=null,Un=null,Hn=null;function Ua(e){if(e=Vr(e)){if(typeof Rl!="function")throw Error(w(280));var t=e.stateNode;t&&(t=fi(t),Rl(e.stateNode,e.type,t))}}function Ju(e){Un?Hn?Hn.push(e):Hn=[e]:Un=e}function qu(){if(Un){var e=Un,t=Hn;if(Hn=Un=null,Ua(e),t)for(e=0;e<t.length;e++)Ua(t[e])}}function ec(e,t){return e(t)}function tc(){}var qi=!1;function nc(e,t,n){if(qi)return e(t,n);qi=!0;try{return ec(e,t,n)}finally{qi=!1,(Un!==null||Hn!==null)&&(tc(),qu())}}function zr(e,t){var n=e.stateNode;if(n===null)return null;var r=fi(n);if(r===null)return null;n=r[t];e:switch(t){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(r=!r.disabled)||(e=e.type,r=!(e==="button"||e==="input"||e==="select"||e==="textarea")),e=!r;break e;default:e=!1}if(e)return null;if(n&&typeof n!="function")throw Error(w(231,t,typeof n));return n}var Tl=!1;if(It)try{Nn={},Object.defineProperty(Nn,"passive",{get:function(){Tl=!0}}),window.addEventListener("test",Nn,Nn),window.removeEventListener("test",Nn,Nn)}catch{Tl=!1}var Nn;function uf(e,t,n,r,o,i,l,s,a){var c=Array.prototype.slice.call(arguments,3);try{t.apply(n,c)}catch(m){this.onError(m)}}var yr=!1,$o=null,Uo=!1,Ll=null,cf={onError:function(e){yr=!0,$o=e}};function df(e,t,n,r,o,i,l,s,a){yr=!1,$o=null,uf.apply(cf,arguments)}function pf(e,t,n,r,o,i,l,s,a){if(df.apply(this,arguments),yr){if(yr){var c=$o;yr=!1,$o=null}else throw Error(w(198));Uo||(Uo=!0,Ll=c)}}function bn(e){var t=e,n=e;if(e.alternate)for(;t.return;)t=t.return;else{e=t;do t=e,(t.flags&4098)!==0&&(n=t.return),e=t.return;while(e)}return t.tag===3?n:null}function rc(e){if(e.tag===13){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function Ha(e){if(bn(e)!==e)throw Error(w(188))}function ff(e){var t=e.alternate;if(!t){if(t=bn(e),t===null)throw Error(w(188));return t!==e?null:e}for(var n=e,r=t;;){var o=n.return;if(o===null)break;var i=o.alternate;if(i===null){if(r=o.return,r!==null){n=r;continue}break}if(o.child===i.child){for(i=o.child;i;){if(i===n)return Ha(o),e;if(i===r)return Ha(o),t;i=i.sibling}throw Error(w(188))}if(n.return!==r.return)n=o,r=i;else{for(var l=!1,s=o.child;s;){if(s===n){l=!0,n=o,r=i;break}if(s===r){l=!0,r=o,n=i;break}s=s.sibling}if(!l){for(s=i.child;s;){if(s===n){l=!0,n=i,r=o;break}if(s===r){l=!0,r=i,n=o;break}s=s.sibling}if(!l)throw Error(w(189))}}if(n.alternate!==r)throw Error(w(190))}if(n.tag!==3)throw Error(w(188));return n.stateNode.current===n?e:t}function oc(e){return e=ff(e),e!==null?ic(e):null}function ic(e){if(e.tag===5||e.tag===6)return e;for(e=e.child;e!==null;){var t=ic(e);if(t!==null)return t;e=e.sibling}return null}var lc=Qe.unstable_scheduleCallback,Ba=Qe.unstable_cancelCallback,gf=Qe.unstable_shouldYield,mf=Qe.unstable_requestPaint,ae=Qe.unstable_now,hf=Qe.unstable_getCurrentPriorityLevel,vs=Qe.unstable_ImmediatePriority,sc=Qe.unstable_UserBlockingPriority,Ho=Qe.unstable_NormalPriority,vf=Qe.unstable_LowPriority,ac=Qe.unstable_IdlePriority,ui=null,xt=null;function yf(e){if(xt&&typeof xt.onCommitFiberRoot=="function")try{xt.onCommitFiberRoot(ui,e,void 0,(e.current.flags&128)===128)}catch{}}var pt=Math.clz32?Math.clz32:kf,xf=Math.log,wf=Math.LN2;function kf(e){return e>>>=0,e===0?32:31-(xf(e)/wf|0)|0}var fo=64,go=4194304;function mr(e){switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return e&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;default:return e}}function Bo(e,t){var n=e.pendingLanes;if(n===0)return 0;var r=0,o=e.suspendedLanes,i=e.pingedLanes,l=n&268435455;if(l!==0){var s=l&~o;s!==0?r=mr(s):(i&=l,i!==0&&(r=mr(i)))}else l=n&~o,l!==0?r=mr(l):i!==0&&(r=mr(i));if(r===0)return 0;if(t!==0&&t!==r&&(t&o)===0&&(o=r&-r,i=t&-t,o>=i||o===16&&(i&4194240)!==0))return t;if((r&4)!==0&&(r|=n&16),t=e.entangledLanes,t!==0)for(e=e.entanglements,t&=r;0<t;)n=31-pt(t),o=1<<n,r|=e[n],t&=~o;return r}function Sf(e,t){switch(e){case 1:case 2:case 4:return t+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return t+5e3;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function bf(e,t){for(var n=e.suspendedLanes,r=e.pingedLanes,o=e.expirationTimes,i=e.pendingLanes;0<i;){var l=31-pt(i),s=1<<l,a=o[l];a===-1?((s&n)===0||(s&r)!==0)&&(o[l]=Sf(s,t)):a<=t&&(e.expiredLanes|=s),i&=~s}}function Ml(e){return e=e.pendingLanes&-1073741825,e!==0?e:e&1073741824?1073741824:0}function uc(){var e=fo;return fo<<=1,(fo&4194240)===0&&(fo=64),e}function el(e){for(var t=[],n=0;31>n;n++)t.push(e);return t}function Br(e,t,n){e.pendingLanes|=t,t!==536870912&&(e.suspendedLanes=0,e.pingedLanes=0),e=e.eventTimes,t=31-pt(t),e[t]=n}function Cf(e,t){var n=e.pendingLanes&~t;e.pendingLanes=t,e.suspendedLanes=0,e.pingedLanes=0,e.expiredLanes&=t,e.mutableReadLanes&=t,e.entangledLanes&=t,t=e.entanglements;var r=e.eventTimes;for(e=e.expirationTimes;0<n;){var o=31-pt(n),i=1<<o;t[o]=0,r[o]=-1,e[o]=-1,n&=~i}}function ys(e,t){var n=e.entangledLanes|=t;for(e=e.entanglements;n;){var r=31-pt(n),o=1<<r;o&t|e[r]&t&&(e[r]|=t),n&=~o}}var G=0;function cc(e){return e&=-e,1<e?4<e?(e&268435455)!==0?16:536870912:4:1}var dc,xs,pc,fc,gc,Dl=!1,mo=[],Yt=null,Xt=null,Zt=null,_r=new Map,Ir=new Map,Vt=[],Ef="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");function Wa(e,t){switch(e){case"focusin":case"focusout":Yt=null;break;case"dragenter":case"dragleave":Xt=null;break;case"mouseover":case"mouseout":Zt=null;break;case"pointerover":case"pointerout":_r.delete(t.pointerId);break;case"gotpointercapture":case"lostpointercapture":Ir.delete(t.pointerId)}}function lr(e,t,n,r,o,i){return e===null||e.nativeEvent!==i?(e={blockedOn:t,domEventName:n,eventSystemFlags:r,nativeEvent:i,targetContainers:[o]},t!==null&&(t=Vr(t),t!==null&&xs(t)),e):(e.eventSystemFlags|=r,t=e.targetContainers,o!==null&&t.indexOf(o)===-1&&t.push(o),e)}function Nf(e,t,n,r,o){switch(t){case"focusin":return Yt=lr(Yt,e,t,n,r,o),!0;case"dragenter":return Xt=lr(Xt,e,t,n,r,o),!0;case"mouseover":return Zt=lr(Zt,e,t,n,r,o),!0;case"pointerover":var i=o.pointerId;return _r.set(i,lr(_r.get(i)||null,e,t,n,r,o)),!0;case"gotpointercapture":return i=o.pointerId,Ir.set(i,lr(Ir.get(i)||null,e,t,n,r,o)),!0}return!1}function mc(e){var t=pn(e.target);if(t!==null){var n=bn(t);if(n!==null){if(t=n.tag,t===13){if(t=rc(n),t!==null){e.blockedOn=t,gc(e.priority,function(){pc(n)});return}}else if(t===3&&n.stateNode.current.memoizedState.isDehydrated){e.blockedOn=n.tag===3?n.stateNode.containerInfo:null;return}}}e.blockedOn=null}function _o(e){if(e.blockedOn!==null)return!1;for(var t=e.targetContainers;0<t.length;){var n=Ol(e.domEventName,e.eventSystemFlags,t[0],e.nativeEvent);if(n===null){n=e.nativeEvent;var r=new n.constructor(n.type,n);Il=r,n.target.dispatchEvent(r),Il=null}else return t=Vr(n),t!==null&&xs(t),e.blockedOn=n,!1;t.shift()}return!0}function Va(e,t,n){_o(e)&&n.delete(t)}function Pf(){Dl=!1,Yt!==null&&_o(Yt)&&(Yt=null),Xt!==null&&_o(Xt)&&(Xt=null),Zt!==null&&_o(Zt)&&(Zt=null),_r.forEach(Va),Ir.forEach(Va)}function sr(e,t){e.blockedOn===t&&(e.blockedOn=null,Dl||(Dl=!0,Qe.unstable_scheduleCallback(Qe.unstable_NormalPriority,Pf)))}function Rr(e){function t(o){return sr(o,e)}if(0<mo.length){sr(mo[0],e);for(var n=1;n<mo.length;n++){var r=mo[n];r.blockedOn===e&&(r.blockedOn=null)}}for(Yt!==null&&sr(Yt,e),Xt!==null&&sr(Xt,e),Zt!==null&&sr(Zt,e),_r.forEach(t),Ir.forEach(t),n=0;n<Vt.length;n++)r=Vt[n],r.blockedOn===e&&(r.blockedOn=null);for(;0<Vt.length&&(n=Vt[0],n.blockedOn===null);)mc(n),n.blockedOn===null&&Vt.shift()}var Bn=Mt.ReactCurrentBatchConfig,Wo=!0;function zf(e,t,n,r){var o=G,i=Bn.transition;Bn.transition=null;try{G=1,ws(e,t,n,r)}finally{G=o,Bn.transition=i}}function _f(e,t,n,r){var o=G,i=Bn.transition;Bn.transition=null;try{G=4,ws(e,t,n,r)}finally{G=o,Bn.transition=i}}function ws(e,t,n,r){if(Wo){var o=Ol(e,t,n,r);if(o===null)sl(e,t,r,Vo,n),Wa(e,r);else if(Nf(o,e,t,n,r))r.stopPropagation();else if(Wa(e,r),t&4&&-1<Ef.indexOf(e)){for(;o!==null;){var i=Vr(o);if(i!==null&&dc(i),i=Ol(e,t,n,r),i===null&&sl(e,t,r,Vo,n),i===o)break;o=i}o!==null&&r.stopPropagation()}else sl(e,t,r,null,n)}}var Vo=null;function Ol(e,t,n,r){if(Vo=null,e=hs(r),e=pn(e),e!==null)if(t=bn(e),t===null)e=null;else if(n=t.tag,n===13){if(e=rc(t),e!==null)return e;e=null}else if(n===3){if(t.stateNode.current.memoizedState.isDehydrated)return t.tag===3?t.stateNode.containerInfo:null;e=null}else t!==e&&(e=null);return Vo=e,null}function hc(e){switch(e){case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 1;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"toggle":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 4;case"message":switch(hf()){case vs:return 1;case sc:return 4;case Ho:case vf:return 16;case ac:return 536870912;default:return 16}default:return 16}}var Qt=null,ks=null,Io=null;function vc(){if(Io)return Io;var e,t=ks,n=t.length,r,o="value"in Qt?Qt.value:Qt.textContent,i=o.length;for(e=0;e<n&&t[e]===o[e];e++);var l=n-e;for(r=1;r<=l&&t[n-r]===o[i-r];r++);return Io=o.slice(e,1<r?1-r:void 0)}function Ro(e){var t=e.keyCode;return"charCode"in e?(e=e.charCode,e===0&&t===13&&(e=13)):e=t,e===10&&(e=13),32<=e||e===13?e:0}function ho(){return!0}function Ga(){return!1}function Ke(e){function t(n,r,o,i,l){this._reactName=n,this._targetInst=o,this.type=r,this.nativeEvent=i,this.target=l,this.currentTarget=null;for(var s in e)e.hasOwnProperty(s)&&(n=e[s],this[s]=n?n(i):i[s]);return this.isDefaultPrevented=(i.defaultPrevented!=null?i.defaultPrevented:i.returnValue===!1)?ho:Ga,this.isPropagationStopped=Ga,this}return re(t.prototype,{preventDefault:function(){this.defaultPrevented=!0;var n=this.nativeEvent;n&&(n.preventDefault?n.preventDefault():typeof n.returnValue!="unknown"&&(n.returnValue=!1),this.isDefaultPrevented=ho)},stopPropagation:function(){var n=this.nativeEvent;n&&(n.stopPropagation?n.stopPropagation():typeof n.cancelBubble!="unknown"&&(n.cancelBubble=!0),this.isPropagationStopped=ho)},persist:function(){},isPersistent:ho}),t}var qn={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Ss=Ke(qn),Wr=re({},qn,{view:0,detail:0}),If=Ke(Wr),tl,nl,ar,ci=re({},Wr,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:bs,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){return"movementX"in e?e.movementX:(e!==ar&&(ar&&e.type==="mousemove"?(tl=e.screenX-ar.screenX,nl=e.screenY-ar.screenY):nl=tl=0,ar=e),tl)},movementY:function(e){return"movementY"in e?e.movementY:nl}}),Qa=Ke(ci),Rf=re({},ci,{dataTransfer:0}),Tf=Ke(Rf),Lf=re({},Wr,{relatedTarget:0}),rl=Ke(Lf),Mf=re({},qn,{animationName:0,elapsedTime:0,pseudoElement:0}),Df=Ke(Mf),Of=re({},qn,{clipboardData:function(e){return"clipboardData"in e?e.clipboardData:window.clipboardData}}),Af=Ke(Of),Ff=re({},qn,{data:0}),Ka=Ke(Ff),jf={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},$f={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},Uf={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};function Hf(e){var t=this.nativeEvent;return t.getModifierState?t.getModifierState(e):(e=Uf[e])?!!t[e]:!1}function bs(){return Hf}var Bf=re({},Wr,{key:function(e){if(e.key){var t=jf[e.key]||e.key;if(t!=="Unidentified")return t}return e.type==="keypress"?(e=Ro(e),e===13?"Enter":String.fromCharCode(e)):e.type==="keydown"||e.type==="keyup"?$f[e.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:bs,charCode:function(e){return e.type==="keypress"?Ro(e):0},keyCode:function(e){return e.type==="keydown"||e.type==="keyup"?e.keyCode:0},which:function(e){return e.type==="keypress"?Ro(e):e.type==="keydown"||e.type==="keyup"?e.keyCode:0}}),Wf=Ke(Bf),Vf=re({},ci,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),Ya=Ke(Vf),Gf=re({},Wr,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:bs}),Qf=Ke(Gf),Kf=re({},qn,{propertyName:0,elapsedTime:0,pseudoElement:0}),Yf=Ke(Kf),Xf=re({},ci,{deltaX:function(e){return"deltaX"in e?e.deltaX:"wheelDeltaX"in e?-e.wheelDeltaX:0},deltaY:function(e){return"deltaY"in e?e.deltaY:"wheelDeltaY"in e?-e.wheelDeltaY:"wheelDelta"in e?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),Zf=Ke(Xf),Jf=[9,13,27,32],Cs=It&&"CompositionEvent"in window,xr=null;It&&"documentMode"in document&&(xr=document.documentMode);var qf=It&&"TextEvent"in window&&!xr,yc=It&&(!Cs||xr&&8<xr&&11>=xr),Xa=" ",Za=!1;function xc(e,t){switch(e){case"keyup":return Jf.indexOf(t.keyCode)!==-1;case"keydown":return t.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function wc(e){return e=e.detail,typeof e=="object"&&"data"in e?e.data:null}var In=!1;function eg(e,t){switch(e){case"compositionend":return wc(t);case"keypress":return t.which!==32?null:(Za=!0,Xa);case"textInput":return e=t.data,e===Xa&&Za?null:e;default:return null}}function tg(e,t){if(In)return e==="compositionend"||!Cs&&xc(e,t)?(e=vc(),Io=ks=Qt=null,In=!1,e):null;switch(e){case"paste":return null;case"keypress":if(!(t.ctrlKey||t.altKey||t.metaKey)||t.ctrlKey&&t.altKey){if(t.char&&1<t.char.length)return t.char;if(t.which)return String.fromCharCode(t.which)}return null;case"compositionend":return yc&&t.locale!=="ko"?null:t.data;default:return null}}var ng={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function Ja(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t==="input"?!!ng[e.type]:t==="textarea"}function kc(e,t,n,r){Ju(r),t=Go(t,"onChange"),0<t.length&&(n=new Ss("onChange","change",null,n,r),e.push({event:n,listeners:t}))}var wr=null,Tr=null;function rg(e){Tc(e,0)}function di(e){var t=Ln(e);if(Vu(t))return e}function og(e,t){if(e==="change")return t}var Sc=!1;It&&(It?(yo="oninput"in document,yo||(ol=document.createElement("div"),ol.setAttribute("oninput","return;"),yo=typeof ol.oninput=="function"),vo=yo):vo=!1,Sc=vo&&(!document.documentMode||9<document.documentMode));var vo,yo,ol;function qa(){wr&&(wr.detachEvent("onpropertychange",bc),Tr=wr=null)}function bc(e){if(e.propertyName==="value"&&di(Tr)){var t=[];kc(t,Tr,e,hs(e)),nc(rg,t)}}function ig(e,t,n){e==="focusin"?(qa(),wr=t,Tr=n,wr.attachEvent("onpropertychange",bc)):e==="focusout"&&qa()}function lg(e){if(e==="selectionchange"||e==="keyup"||e==="keydown")return di(Tr)}function sg(e,t){if(e==="click")return di(t)}function ag(e,t){if(e==="input"||e==="change")return di(t)}function ug(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}var gt=typeof Object.is=="function"?Object.is:ug;function Lr(e,t){if(gt(e,t))return!0;if(typeof e!="object"||e===null||typeof t!="object"||t===null)return!1;var n=Object.keys(e),r=Object.keys(t);if(n.length!==r.length)return!1;for(r=0;r<n.length;r++){var o=n[r];if(!yl.call(t,o)||!gt(e[o],t[o]))return!1}return!0}function eu(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function tu(e,t){var n=eu(e);e=0;for(var r;n;){if(n.nodeType===3){if(r=e+n.textContent.length,e<=t&&r>=t)return{node:n,offset:t-e};e=r}e:{for(;n;){if(n.nextSibling){n=n.nextSibling;break e}n=n.parentNode}n=void 0}n=eu(n)}}function Cc(e,t){return e&&t?e===t?!0:e&&e.nodeType===3?!1:t&&t.nodeType===3?Cc(e,t.parentNode):"contains"in e?e.contains(t):e.compareDocumentPosition?!!(e.compareDocumentPosition(t)&16):!1:!1}function Ec(){for(var e=window,t=jo();t instanceof e.HTMLIFrameElement;){try{var n=typeof t.contentWindow.location.href=="string"}catch{n=!1}if(n)e=t.contentWindow;else break;t=jo(e.document)}return t}function Es(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t&&(t==="input"&&(e.type==="text"||e.type==="search"||e.type==="tel"||e.type==="url"||e.type==="password")||t==="textarea"||e.contentEditable==="true")}function cg(e){var t=Ec(),n=e.focusedElem,r=e.selectionRange;if(t!==n&&n&&n.ownerDocument&&Cc(n.ownerDocument.documentElement,n)){if(r!==null&&Es(n)){if(t=r.start,e=r.end,e===void 0&&(e=t),"selectionStart"in n)n.selectionStart=t,n.selectionEnd=Math.min(e,n.value.length);else if(e=(t=n.ownerDocument||document)&&t.defaultView||window,e.getSelection){e=e.getSelection();var o=n.textContent.length,i=Math.min(r.start,o);r=r.end===void 0?i:Math.min(r.end,o),!e.extend&&i>r&&(o=r,r=i,i=o),o=tu(n,i);var l=tu(n,r);o&&l&&(e.rangeCount!==1||e.anchorNode!==o.node||e.anchorOffset!==o.offset||e.focusNode!==l.node||e.focusOffset!==l.offset)&&(t=t.createRange(),t.setStart(o.node,o.offset),e.removeAllRanges(),i>r?(e.addRange(t),e.extend(l.node,l.offset)):(t.setEnd(l.node,l.offset),e.addRange(t)))}}for(t=[],e=n;e=e.parentNode;)e.nodeType===1&&t.push({element:e,left:e.scrollLeft,top:e.scrollTop});for(typeof n.focus=="function"&&n.focus(),n=0;n<t.length;n++)e=t[n],e.element.scrollLeft=e.left,e.element.scrollTop=e.top}}var dg=It&&"documentMode"in document&&11>=document.documentMode,Rn=null,Al=null,kr=null,Fl=!1;function nu(e,t,n){var r=n.window===n?n.document:n.nodeType===9?n:n.ownerDocument;Fl||Rn==null||Rn!==jo(r)||(r=Rn,"selectionStart"in r&&Es(r)?r={start:r.selectionStart,end:r.selectionEnd}:(r=(r.ownerDocument&&r.ownerDocument.defaultView||window).getSelection(),r={anchorNode:r.anchorNode,anchorOffset:r.anchorOffset,focusNode:r.focusNode,focusOffset:r.focusOffset}),kr&&Lr(kr,r)||(kr=r,r=Go(Al,"onSelect"),0<r.length&&(t=new Ss("onSelect","select",null,t,n),e.push({event:t,listeners:r}),t.target=Rn)))}function xo(e,t){var n={};return n[e.toLowerCase()]=t.toLowerCase(),n["Webkit"+e]="webkit"+t,n["Moz"+e]="moz"+t,n}var Tn={animationend:xo("Animation","AnimationEnd"),animationiteration:xo("Animation","AnimationIteration"),animationstart:xo("Animation","AnimationStart"),transitionend:xo("Transition","TransitionEnd")},il={},Nc={};It&&(Nc=document.createElement("div").style,"AnimationEvent"in window||(delete Tn.animationend.animation,delete Tn.animationiteration.animation,delete Tn.animationstart.animation),"TransitionEvent"in window||delete Tn.transitionend.transition);function pi(e){if(il[e])return il[e];if(!Tn[e])return e;var t=Tn[e],n;for(n in t)if(t.hasOwnProperty(n)&&n in Nc)return il[e]=t[n];return e}var Pc=pi("animationend"),zc=pi("animationiteration"),_c=pi("animationstart"),Ic=pi("transitionend"),Rc=new Map,ru="abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");function ln(e,t){Rc.set(e,t),Sn(t,[e])}for(wo=0;wo<ru.length;wo++)ko=ru[wo],ou=ko.toLowerCase(),iu=ko[0].toUpperCase()+ko.slice(1),ln(ou,"on"+iu);var ko,ou,iu,wo;ln(Pc,"onAnimationEnd");ln(zc,"onAnimationIteration");ln(_c,"onAnimationStart");ln("dblclick","onDoubleClick");ln("focusin","onFocus");ln("focusout","onBlur");ln(Ic,"onTransitionEnd");Gn("onMouseEnter",["mouseout","mouseover"]);Gn("onMouseLeave",["mouseout","mouseover"]);Gn("onPointerEnter",["pointerout","pointerover"]);Gn("onPointerLeave",["pointerout","pointerover"]);Sn("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));Sn("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));Sn("onBeforeInput",["compositionend","keypress","textInput","paste"]);Sn("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));Sn("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));Sn("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));var hr="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),pg=new Set("cancel close invalid load scroll toggle".split(" ").concat(hr));function lu(e,t,n){var r=e.type||"unknown-event";e.currentTarget=n,pf(r,t,void 0,e),e.currentTarget=null}function Tc(e,t){t=(t&4)!==0;for(var n=0;n<e.length;n++){var r=e[n],o=r.event;r=r.listeners;e:{var i=void 0;if(t)for(var l=r.length-1;0<=l;l--){var s=r[l],a=s.instance,c=s.currentTarget;if(s=s.listener,a!==i&&o.isPropagationStopped())break e;lu(o,s,c),i=a}else for(l=0;l<r.length;l++){if(s=r[l],a=s.instance,c=s.currentTarget,s=s.listener,a!==i&&o.isPropagationStopped())break e;lu(o,s,c),i=a}}}if(Uo)throw e=Ll,Uo=!1,Ll=null,e}function X(e,t){var n=t[Bl];n===void 0&&(n=t[Bl]=new Set);var r=e+"__bubble";n.has(r)||(Lc(t,e,2,!1),n.add(r))}function ll(e,t,n){var r=0;t&&(r|=4),Lc(n,e,r,t)}var So="_reactListening"+Math.random().toString(36).slice(2);function Mr(e){if(!e[So]){e[So]=!0,$u.forEach(function(n){n!=="selectionchange"&&(pg.has(n)||ll(n,!1,e),ll(n,!0,e))});var t=e.nodeType===9?e:e.ownerDocument;t===null||t[So]||(t[So]=!0,ll("selectionchange",!1,t))}}function Lc(e,t,n,r){switch(hc(t)){case 1:var o=zf;break;case 4:o=_f;break;default:o=ws}n=o.bind(null,t,n,e),o=void 0,!Tl||t!=="touchstart"&&t!=="touchmove"&&t!=="wheel"||(o=!0),r?o!==void 0?e.addEventListener(t,n,{capture:!0,passive:o}):e.addEventListener(t,n,!0):o!==void 0?e.addEventListener(t,n,{passive:o}):e.addEventListener(t,n,!1)}function sl(e,t,n,r,o){var i=r;if((t&1)===0&&(t&2)===0&&r!==null)e:for(;;){if(r===null)return;var l=r.tag;if(l===3||l===4){var s=r.stateNode.containerInfo;if(s===o||s.nodeType===8&&s.parentNode===o)break;if(l===4)for(l=r.return;l!==null;){var a=l.tag;if((a===3||a===4)&&(a=l.stateNode.containerInfo,a===o||a.nodeType===8&&a.parentNode===o))return;l=l.return}for(;s!==null;){if(l=pn(s),l===null)return;if(a=l.tag,a===5||a===6){r=i=l;continue e}s=s.parentNode}}r=r.return}nc(function(){var c=i,m=hs(n),g=[];e:{var p=Rc.get(e);if(p!==void 0){var v=Ss,y=e;switch(e){case"keypress":if(Ro(n)===0)break e;case"keydown":case"keyup":v=Wf;break;case"focusin":y="focus",v=rl;break;case"focusout":y="blur",v=rl;break;case"beforeblur":case"afterblur":v=rl;break;case"click":if(n.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":v=Qa;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":v=Tf;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":v=Qf;break;case Pc:case zc:case _c:v=Df;break;case Ic:v=Yf;break;case"scroll":v=If;break;case"wheel":v=Zf;break;case"copy":case"cut":case"paste":v=Af;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":v=Ya}var h=(t&4)!==0,I=!h&&e==="scroll",d=h?p!==null?p+"Capture":null:p;h=[];for(var u=c,f;u!==null;){f=u;var x=f.stateNode;if(f.tag===5&&x!==null&&(f=x,d!==null&&(x=zr(u,d),x!=null&&h.push(Dr(u,x,f)))),I)break;u=u.return}0<h.length&&(p=new v(p,y,null,n,m),g.push({event:p,listeners:h}))}}if((t&7)===0){e:{if(p=e==="mouseover"||e==="pointerover",v=e==="mouseout"||e==="pointerout",p&&n!==Il&&(y=n.relatedTarget||n.fromElement)&&(pn(y)||y[Rt]))break e;if((v||p)&&(p=m.window===m?m:(p=m.ownerDocument)?p.defaultView||p.parentWindow:window,v?(y=n.relatedTarget||n.toElement,v=c,y=y?pn(y):null,y!==null&&(I=bn(y),y!==I||y.tag!==5&&y.tag!==6)&&(y=null)):(v=null,y=c),v!==y)){if(h=Qa,x="onMouseLeave",d="onMouseEnter",u="mouse",(e==="pointerout"||e==="pointerover")&&(h=Ya,x="onPointerLeave",d="onPointerEnter",u="pointer"),I=v==null?p:Ln(v),f=y==null?p:Ln(y),p=new h(x,u+"leave",v,n,m),p.target=I,p.relatedTarget=f,x=null,pn(m)===c&&(h=new h(d,u+"enter",y,n,m),h.target=f,h.relatedTarget=I,x=h),I=x,v&&y)t:{for(h=v,d=y,u=0,f=h;f;f=Pn(f))u++;for(f=0,x=d;x;x=Pn(x))f++;for(;0<u-f;)h=Pn(h),u--;for(;0<f-u;)d=Pn(d),f--;for(;u--;){if(h===d||d!==null&&h===d.alternate)break t;h=Pn(h),d=Pn(d)}h=null}else h=null;v!==null&&su(g,p,v,h,!1),y!==null&&I!==null&&su(g,I,y,h,!0)}}e:{if(p=c?Ln(c):window,v=p.nodeName&&p.nodeName.toLowerCase(),v==="select"||v==="input"&&p.type==="file")var S=og;else if(Ja(p))if(Sc)S=ag;else{S=lg;var k=ig}else(v=p.nodeName)&&v.toLowerCase()==="input"&&(p.type==="checkbox"||p.type==="radio")&&(S=sg);if(S&&(S=S(e,c))){kc(g,S,n,m);break e}k&&k(e,p,c),e==="focusout"&&(k=p._wrapperState)&&k.controlled&&p.type==="number"&&El(p,"number",p.value)}switch(k=c?Ln(c):window,e){case"focusin":(Ja(k)||k.contentEditable==="true")&&(Rn=k,Al=c,kr=null);break;case"focusout":kr=Al=Rn=null;break;case"mousedown":Fl=!0;break;case"contextmenu":case"mouseup":case"dragend":Fl=!1,nu(g,n,m);break;case"selectionchange":if(dg)break;case"keydown":case"keyup":nu(g,n,m)}var C;if(Cs)e:{switch(e){case"compositionstart":var b="onCompositionStart";break e;case"compositionend":b="onCompositionEnd";break e;case"compositionupdate":b="onCompositionUpdate";break e}b=void 0}else In?xc(e,n)&&(b="onCompositionEnd"):e==="keydown"&&n.keyCode===229&&(b="onCompositionStart");b&&(yc&&n.locale!=="ko"&&(In||b!=="onCompositionStart"?b==="onCompositionEnd"&&In&&(C=vc()):(Qt=m,ks="value"in Qt?Qt.value:Qt.textContent,In=!0)),k=Go(c,b),0<k.length&&(b=new Ka(b,e,null,n,m),g.push({event:b,listeners:k}),C?b.data=C:(C=wc(n),C!==null&&(b.data=C)))),(C=qf?eg(e,n):tg(e,n))&&(c=Go(c,"onBeforeInput"),0<c.length&&(m=new Ka("onBeforeInput","beforeinput",null,n,m),g.push({event:m,listeners:c}),m.data=C))}Tc(g,t)})}function Dr(e,t,n){return{instance:e,listener:t,currentTarget:n}}function Go(e,t){for(var n=t+"Capture",r=[];e!==null;){var o=e,i=o.stateNode;o.tag===5&&i!==null&&(o=i,i=zr(e,n),i!=null&&r.unshift(Dr(e,i,o)),i=zr(e,t),i!=null&&r.push(Dr(e,i,o))),e=e.return}return r}function Pn(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5);return e||null}function su(e,t,n,r,o){for(var i=t._reactName,l=[];n!==null&&n!==r;){var s=n,a=s.alternate,c=s.stateNode;if(a!==null&&a===r)break;s.tag===5&&c!==null&&(s=c,o?(a=zr(n,i),a!=null&&l.unshift(Dr(n,a,s))):o||(a=zr(n,i),a!=null&&l.push(Dr(n,a,s)))),n=n.return}l.length!==0&&e.push({event:t,listeners:l})}var fg=/\r\n?/g,gg=/\u0000|\uFFFD/g;function au(e){return(typeof e=="string"?e:""+e).replace(fg,`
`).replace(gg,"")}function bo(e,t,n){if(t=au(t),au(e)!==t&&n)throw Error(w(425))}function Qo(){}var jl=null,$l=null;function Ul(e,t){return e==="textarea"||e==="noscript"||typeof t.children=="string"||typeof t.children=="number"||typeof t.dangerouslySetInnerHTML=="object"&&t.dangerouslySetInnerHTML!==null&&t.dangerouslySetInnerHTML.__html!=null}var Hl=typeof setTimeout=="function"?setTimeout:void 0,mg=typeof clearTimeout=="function"?clearTimeout:void 0,uu=typeof Promise=="function"?Promise:void 0,hg=typeof queueMicrotask=="function"?queueMicrotask:typeof uu<"u"?function(e){return uu.resolve(null).then(e).catch(vg)}:Hl;function vg(e){setTimeout(function(){throw e})}function al(e,t){var n=t,r=0;do{var o=n.nextSibling;if(e.removeChild(n),o&&o.nodeType===8)if(n=o.data,n==="/$"){if(r===0){e.removeChild(o),Rr(t);return}r--}else n!=="$"&&n!=="$?"&&n!=="$!"||r++;n=o}while(n);Rr(t)}function Jt(e){for(;e!=null;e=e.nextSibling){var t=e.nodeType;if(t===1||t===3)break;if(t===8){if(t=e.data,t==="$"||t==="$!"||t==="$?")break;if(t==="/$")return null}}return e}function cu(e){e=e.previousSibling;for(var t=0;e;){if(e.nodeType===8){var n=e.data;if(n==="$"||n==="$!"||n==="$?"){if(t===0)return e;t--}else n==="/$"&&t++}e=e.previousSibling}return null}var er=Math.random().toString(36).slice(2),yt="__reactFiber$"+er,Or="__reactProps$"+er,Rt="__reactContainer$"+er,Bl="__reactEvents$"+er,yg="__reactListeners$"+er,xg="__reactHandles$"+er;function pn(e){var t=e[yt];if(t)return t;for(var n=e.parentNode;n;){if(t=n[Rt]||n[yt]){if(n=t.alternate,t.child!==null||n!==null&&n.child!==null)for(e=cu(e);e!==null;){if(n=e[yt])return n;e=cu(e)}return t}e=n,n=e.parentNode}return null}function Vr(e){return e=e[yt]||e[Rt],!e||e.tag!==5&&e.tag!==6&&e.tag!==13&&e.tag!==3?null:e}function Ln(e){if(e.tag===5||e.tag===6)return e.stateNode;throw Error(w(33))}function fi(e){return e[Or]||null}var Wl=[],Mn=-1;function sn(e){return{current:e}}function Z(e){0>Mn||(e.current=Wl[Mn],Wl[Mn]=null,Mn--)}function Y(e,t){Mn++,Wl[Mn]=e.current,e.current=t}var on={},Re=sn(on),Ue=sn(!1),vn=on;function Qn(e,t){var n=e.type.contextTypes;if(!n)return on;var r=e.stateNode;if(r&&r.__reactInternalMemoizedUnmaskedChildContext===t)return r.__reactInternalMemoizedMaskedChildContext;var o={},i;for(i in n)o[i]=t[i];return r&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=t,e.__reactInternalMemoizedMaskedChildContext=o),o}function He(e){return e=e.childContextTypes,e!=null}function Ko(){Z(Ue),Z(Re)}function du(e,t,n){if(Re.current!==on)throw Error(w(168));Y(Re,t),Y(Ue,n)}function Mc(e,t,n){var r=e.stateNode;if(t=t.childContextTypes,typeof r.getChildContext!="function")return n;r=r.getChildContext();for(var o in r)if(!(o in t))throw Error(w(108,of(e)||"Unknown",o));return re({},n,r)}function Yo(e){return e=(e=e.stateNode)&&e.__reactInternalMemoizedMergedChildContext||on,vn=Re.current,Y(Re,e),Y(Ue,Ue.current),!0}function pu(e,t,n){var r=e.stateNode;if(!r)throw Error(w(169));n?(e=Mc(e,t,vn),r.__reactInternalMemoizedMergedChildContext=e,Z(Ue),Z(Re),Y(Re,e)):Z(Ue),Y(Ue,n)}var Nt=null,gi=!1,ul=!1;function Dc(e){Nt===null?Nt=[e]:Nt.push(e)}function wg(e){gi=!0,Dc(e)}function an(){if(!ul&&Nt!==null){ul=!0;var e=0,t=G;try{var n=Nt;for(G=1;e<n.length;e++){var r=n[e];do r=r(!0);while(r!==null)}Nt=null,gi=!1}catch(o){throw Nt!==null&&(Nt=Nt.slice(e+1)),lc(vs,an),o}finally{G=t,ul=!1}}return null}var Dn=[],On=0,Xo=null,Zo=0,Je=[],qe=0,yn=null,Pt=1,zt="";function cn(e,t){Dn[On++]=Zo,Dn[On++]=Xo,Xo=e,Zo=t}function Oc(e,t,n){Je[qe++]=Pt,Je[qe++]=zt,Je[qe++]=yn,yn=e;var r=Pt;e=zt;var o=32-pt(r)-1;r&=~(1<<o),n+=1;var i=32-pt(t)+o;if(30<i){var l=o-o%5;i=(r&(1<<l)-1).toString(32),r>>=l,o-=l,Pt=1<<32-pt(t)+o|n<<o|r,zt=i+e}else Pt=1<<i|n<<o|r,zt=e}function Ns(e){e.return!==null&&(cn(e,1),Oc(e,1,0))}function Ps(e){for(;e===Xo;)Xo=Dn[--On],Dn[On]=null,Zo=Dn[--On],Dn[On]=null;for(;e===yn;)yn=Je[--qe],Je[qe]=null,zt=Je[--qe],Je[qe]=null,Pt=Je[--qe],Je[qe]=null}var Ge=null,Ve=null,J=!1,dt=null;function Ac(e,t){var n=et(5,null,null,0);n.elementType="DELETED",n.stateNode=t,n.return=e,t=e.deletions,t===null?(e.deletions=[n],e.flags|=16):t.push(n)}function fu(e,t){switch(e.tag){case 5:var n=e.type;return t=t.nodeType!==1||n.toLowerCase()!==t.nodeName.toLowerCase()?null:t,t!==null?(e.stateNode=t,Ge=e,Ve=Jt(t.firstChild),!0):!1;case 6:return t=e.pendingProps===""||t.nodeType!==3?null:t,t!==null?(e.stateNode=t,Ge=e,Ve=null,!0):!1;case 13:return t=t.nodeType!==8?null:t,t!==null?(n=yn!==null?{id:Pt,overflow:zt}:null,e.memoizedState={dehydrated:t,treeContext:n,retryLane:1073741824},n=et(18,null,null,0),n.stateNode=t,n.return=e,e.child=n,Ge=e,Ve=null,!0):!1;default:return!1}}function Vl(e){return(e.mode&1)!==0&&(e.flags&128)===0}function Gl(e){if(J){var t=Ve;if(t){var n=t;if(!fu(e,t)){if(Vl(e))throw Error(w(418));t=Jt(n.nextSibling);var r=Ge;t&&fu(e,t)?Ac(r,n):(e.flags=e.flags&-4097|2,J=!1,Ge=e)}}else{if(Vl(e))throw Error(w(418));e.flags=e.flags&-4097|2,J=!1,Ge=e}}}function gu(e){for(e=e.return;e!==null&&e.tag!==5&&e.tag!==3&&e.tag!==13;)e=e.return;Ge=e}function Co(e){if(e!==Ge)return!1;if(!J)return gu(e),J=!0,!1;var t;if((t=e.tag!==3)&&!(t=e.tag!==5)&&(t=e.type,t=t!=="head"&&t!=="body"&&!Ul(e.type,e.memoizedProps)),t&&(t=Ve)){if(Vl(e))throw Fc(),Error(w(418));for(;t;)Ac(e,t),t=Jt(t.nextSibling)}if(gu(e),e.tag===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(w(317));e:{for(e=e.nextSibling,t=0;e;){if(e.nodeType===8){var n=e.data;if(n==="/$"){if(t===0){Ve=Jt(e.nextSibling);break e}t--}else n!=="$"&&n!=="$!"&&n!=="$?"||t++}e=e.nextSibling}Ve=null}}else Ve=Ge?Jt(e.stateNode.nextSibling):null;return!0}function Fc(){for(var e=Ve;e;)e=Jt(e.nextSibling)}function Kn(){Ve=Ge=null,J=!1}function zs(e){dt===null?dt=[e]:dt.push(e)}var kg=Mt.ReactCurrentBatchConfig;function ur(e,t,n){if(e=n.ref,e!==null&&typeof e!="function"&&typeof e!="object"){if(n._owner){if(n=n._owner,n){if(n.tag!==1)throw Error(w(309));var r=n.stateNode}if(!r)throw Error(w(147,e));var o=r,i=""+e;return t!==null&&t.ref!==null&&typeof t.ref=="function"&&t.ref._stringRef===i?t.ref:(t=function(l){var s=o.refs;l===null?delete s[i]:s[i]=l},t._stringRef=i,t)}if(typeof e!="string")throw Error(w(284));if(!n._owner)throw Error(w(290,e))}return e}function Eo(e,t){throw e=Object.prototype.toString.call(t),Error(w(31,e==="[object Object]"?"object with keys {"+Object.keys(t).join(", ")+"}":e))}function mu(e){var t=e._init;return t(e._payload)}function jc(e){function t(d,u){if(e){var f=d.deletions;f===null?(d.deletions=[u],d.flags|=16):f.push(u)}}function n(d,u){if(!e)return null;for(;u!==null;)t(d,u),u=u.sibling;return null}function r(d,u){for(d=new Map;u!==null;)u.key!==null?d.set(u.key,u):d.set(u.index,u),u=u.sibling;return d}function o(d,u){return d=nn(d,u),d.index=0,d.sibling=null,d}function i(d,u,f){return d.index=f,e?(f=d.alternate,f!==null?(f=f.index,f<u?(d.flags|=2,u):f):(d.flags|=2,u)):(d.flags|=1048576,u)}function l(d){return e&&d.alternate===null&&(d.flags|=2),d}function s(d,u,f,x){return u===null||u.tag!==6?(u=hl(f,d.mode,x),u.return=d,u):(u=o(u,f),u.return=d,u)}function a(d,u,f,x){var S=f.type;return S===_n?m(d,u,f.props.children,x,f.key):u!==null&&(u.elementType===S||typeof S=="object"&&S!==null&&S.$$typeof===Bt&&mu(S)===u.type)?(x=o(u,f.props),x.ref=ur(d,u,f),x.return=d,x):(x=Fo(f.type,f.key,f.props,null,d.mode,x),x.ref=ur(d,u,f),x.return=d,x)}function c(d,u,f,x){return u===null||u.tag!==4||u.stateNode.containerInfo!==f.containerInfo||u.stateNode.implementation!==f.implementation?(u=vl(f,d.mode,x),u.return=d,u):(u=o(u,f.children||[]),u.return=d,u)}function m(d,u,f,x,S){return u===null||u.tag!==7?(u=hn(f,d.mode,x,S),u.return=d,u):(u=o(u,f),u.return=d,u)}function g(d,u,f){if(typeof u=="string"&&u!==""||typeof u=="number")return u=hl(""+u,d.mode,f),u.return=d,u;if(typeof u=="object"&&u!==null){switch(u.$$typeof){case uo:return f=Fo(u.type,u.key,u.props,null,d.mode,f),f.ref=ur(d,null,u),f.return=d,f;case zn:return u=vl(u,d.mode,f),u.return=d,u;case Bt:var x=u._init;return g(d,x(u._payload),f)}if(gr(u)||ir(u))return u=hn(u,d.mode,f,null),u.return=d,u;Eo(d,u)}return null}function p(d,u,f,x){var S=u!==null?u.key:null;if(typeof f=="string"&&f!==""||typeof f=="number")return S!==null?null:s(d,u,""+f,x);if(typeof f=="object"&&f!==null){switch(f.$$typeof){case uo:return f.key===S?a(d,u,f,x):null;case zn:return f.key===S?c(d,u,f,x):null;case Bt:return S=f._init,p(d,u,S(f._payload),x)}if(gr(f)||ir(f))return S!==null?null:m(d,u,f,x,null);Eo(d,f)}return null}function v(d,u,f,x,S){if(typeof x=="string"&&x!==""||typeof x=="number")return d=d.get(f)||null,s(u,d,""+x,S);if(typeof x=="object"&&x!==null){switch(x.$$typeof){case uo:return d=d.get(x.key===null?f:x.key)||null,a(u,d,x,S);case zn:return d=d.get(x.key===null?f:x.key)||null,c(u,d,x,S);case Bt:var k=x._init;return v(d,u,f,k(x._payload),S)}if(gr(x)||ir(x))return d=d.get(f)||null,m(u,d,x,S,null);Eo(u,x)}return null}function y(d,u,f,x){for(var S=null,k=null,C=u,b=u=0,V=null;C!==null&&b<f.length;b++){C.index>b?(V=C,C=null):V=C.sibling;var M=p(d,C,f[b],x);if(M===null){C===null&&(C=V);break}e&&C&&M.alternate===null&&t(d,C),u=i(M,u,b),k===null?S=M:k.sibling=M,k=M,C=V}if(b===f.length)return n(d,C),J&&cn(d,b),S;if(C===null){for(;b<f.length;b++)C=g(d,f[b],x),C!==null&&(u=i(C,u,b),k===null?S=C:k.sibling=C,k=C);return J&&cn(d,b),S}for(C=r(d,C);b<f.length;b++)V=v(C,d,b,f[b],x),V!==null&&(e&&V.alternate!==null&&C.delete(V.key===null?b:V.key),u=i(V,u,b),k===null?S=V:k.sibling=V,k=V);return e&&C.forEach(function(Ce){return t(d,Ce)}),J&&cn(d,b),S}function h(d,u,f,x){var S=ir(f);if(typeof S!="function")throw Error(w(150));if(f=S.call(f),f==null)throw Error(w(151));for(var k=S=null,C=u,b=u=0,V=null,M=f.next();C!==null&&!M.done;b++,M=f.next()){C.index>b?(V=C,C=null):V=C.sibling;var Ce=p(d,C,M.value,x);if(Ce===null){C===null&&(C=V);break}e&&C&&Ce.alternate===null&&t(d,C),u=i(Ce,u,b),k===null?S=Ce:k.sibling=Ce,k=Ce,C=V}if(M.done)return n(d,C),J&&cn(d,b),S;if(C===null){for(;!M.done;b++,M=f.next())M=g(d,M.value,x),M!==null&&(u=i(M,u,b),k===null?S=M:k.sibling=M,k=M);return J&&cn(d,b),S}for(C=r(d,C);!M.done;b++,M=f.next())M=v(C,d,b,M.value,x),M!==null&&(e&&M.alternate!==null&&C.delete(M.key===null?b:M.key),u=i(M,u,b),k===null?S=M:k.sibling=M,k=M);return e&&C.forEach(function(St){return t(d,St)}),J&&cn(d,b),S}function I(d,u,f,x){if(typeof f=="object"&&f!==null&&f.type===_n&&f.key===null&&(f=f.props.children),typeof f=="object"&&f!==null){switch(f.$$typeof){case uo:e:{for(var S=f.key,k=u;k!==null;){if(k.key===S){if(S=f.type,S===_n){if(k.tag===7){n(d,k.sibling),u=o(k,f.props.children),u.return=d,d=u;break e}}else if(k.elementType===S||typeof S=="object"&&S!==null&&S.$$typeof===Bt&&mu(S)===k.type){n(d,k.sibling),u=o(k,f.props),u.ref=ur(d,k,f),u.return=d,d=u;break e}n(d,k);break}else t(d,k);k=k.sibling}f.type===_n?(u=hn(f.props.children,d.mode,x,f.key),u.return=d,d=u):(x=Fo(f.type,f.key,f.props,null,d.mode,x),x.ref=ur(d,u,f),x.return=d,d=x)}return l(d);case zn:e:{for(k=f.key;u!==null;){if(u.key===k)if(u.tag===4&&u.stateNode.containerInfo===f.containerInfo&&u.stateNode.implementation===f.implementation){n(d,u.sibling),u=o(u,f.children||[]),u.return=d,d=u;break e}else{n(d,u);break}else t(d,u);u=u.sibling}u=vl(f,d.mode,x),u.return=d,d=u}return l(d);case Bt:return k=f._init,I(d,u,k(f._payload),x)}if(gr(f))return y(d,u,f,x);if(ir(f))return h(d,u,f,x);Eo(d,f)}return typeof f=="string"&&f!==""||typeof f=="number"?(f=""+f,u!==null&&u.tag===6?(n(d,u.sibling),u=o(u,f),u.return=d,d=u):(n(d,u),u=hl(f,d.mode,x),u.return=d,d=u),l(d)):n(d,u)}return I}var Yn=jc(!0),$c=jc(!1),Jo=sn(null),qo=null,An=null,_s=null;function Is(){_s=An=qo=null}function Rs(e){var t=Jo.current;Z(Jo),e._currentValue=t}function Ql(e,t,n){for(;e!==null;){var r=e.alternate;if((e.childLanes&t)!==t?(e.childLanes|=t,r!==null&&(r.childLanes|=t)):r!==null&&(r.childLanes&t)!==t&&(r.childLanes|=t),e===n)break;e=e.return}}function Wn(e,t){qo=e,_s=An=null,e=e.dependencies,e!==null&&e.firstContext!==null&&((e.lanes&t)!==0&&($e=!0),e.firstContext=null)}function nt(e){var t=e._currentValue;if(_s!==e)if(e={context:e,memoizedValue:t,next:null},An===null){if(qo===null)throw Error(w(308));An=e,qo.dependencies={lanes:0,firstContext:e}}else An=An.next=e;return t}var fn=null;function Ts(e){fn===null?fn=[e]:fn.push(e)}function Uc(e,t,n,r){var o=t.interleaved;return o===null?(n.next=n,Ts(t)):(n.next=o.next,o.next=n),t.interleaved=n,Tt(e,r)}function Tt(e,t){e.lanes|=t;var n=e.alternate;for(n!==null&&(n.lanes|=t),n=e,e=e.return;e!==null;)e.childLanes|=t,n=e.alternate,n!==null&&(n.childLanes|=t),n=e,e=e.return;return n.tag===3?n.stateNode:null}var Wt=!1;function Ls(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}function Hc(e,t){e=e.updateQueue,t.updateQueue===e&&(t.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,effects:e.effects})}function _t(e,t){return{eventTime:e,lane:t,tag:0,payload:null,callback:null,next:null}}function qt(e,t,n){var r=e.updateQueue;if(r===null)return null;if(r=r.shared,(U&2)!==0){var o=r.pending;return o===null?t.next=t:(t.next=o.next,o.next=t),r.pending=t,Tt(e,n)}return o=r.interleaved,o===null?(t.next=t,Ts(r)):(t.next=o.next,o.next=t),r.interleaved=t,Tt(e,n)}function To(e,t,n){if(t=t.updateQueue,t!==null&&(t=t.shared,(n&4194240)!==0)){var r=t.lanes;r&=e.pendingLanes,n|=r,t.lanes=n,ys(e,n)}}function hu(e,t){var n=e.updateQueue,r=e.alternate;if(r!==null&&(r=r.updateQueue,n===r)){var o=null,i=null;if(n=n.firstBaseUpdate,n!==null){do{var l={eventTime:n.eventTime,lane:n.lane,tag:n.tag,payload:n.payload,callback:n.callback,next:null};i===null?o=i=l:i=i.next=l,n=n.next}while(n!==null);i===null?o=i=t:i=i.next=t}else o=i=t;n={baseState:r.baseState,firstBaseUpdate:o,lastBaseUpdate:i,shared:r.shared,effects:r.effects},e.updateQueue=n;return}e=n.lastBaseUpdate,e===null?n.firstBaseUpdate=t:e.next=t,n.lastBaseUpdate=t}function ei(e,t,n,r){var o=e.updateQueue;Wt=!1;var i=o.firstBaseUpdate,l=o.lastBaseUpdate,s=o.shared.pending;if(s!==null){o.shared.pending=null;var a=s,c=a.next;a.next=null,l===null?i=c:l.next=c,l=a;var m=e.alternate;m!==null&&(m=m.updateQueue,s=m.lastBaseUpdate,s!==l&&(s===null?m.firstBaseUpdate=c:s.next=c,m.lastBaseUpdate=a))}if(i!==null){var g=o.baseState;l=0,m=c=a=null,s=i;do{var p=s.lane,v=s.eventTime;if((r&p)===p){m!==null&&(m=m.next={eventTime:v,lane:0,tag:s.tag,payload:s.payload,callback:s.callback,next:null});e:{var y=e,h=s;switch(p=t,v=n,h.tag){case 1:if(y=h.payload,typeof y=="function"){g=y.call(v,g,p);break e}g=y;break e;case 3:y.flags=y.flags&-65537|128;case 0:if(y=h.payload,p=typeof y=="function"?y.call(v,g,p):y,p==null)break e;g=re({},g,p);break e;case 2:Wt=!0}}s.callback!==null&&s.lane!==0&&(e.flags|=64,p=o.effects,p===null?o.effects=[s]:p.push(s))}else v={eventTime:v,lane:p,tag:s.tag,payload:s.payload,callback:s.callback,next:null},m===null?(c=m=v,a=g):m=m.next=v,l|=p;if(s=s.next,s===null){if(s=o.shared.pending,s===null)break;p=s,s=p.next,p.next=null,o.lastBaseUpdate=p,o.shared.pending=null}}while(!0);if(m===null&&(a=g),o.baseState=a,o.firstBaseUpdate=c,o.lastBaseUpdate=m,t=o.shared.interleaved,t!==null){o=t;do l|=o.lane,o=o.next;while(o!==t)}else i===null&&(o.shared.lanes=0);wn|=l,e.lanes=l,e.memoizedState=g}}function vu(e,t,n){if(e=t.effects,t.effects=null,e!==null)for(t=0;t<e.length;t++){var r=e[t],o=r.callback;if(o!==null){if(r.callback=null,r=n,typeof o!="function")throw Error(w(191,o));o.call(r)}}}var Gr={},wt=sn(Gr),Ar=sn(Gr),Fr=sn(Gr);function gn(e){if(e===Gr)throw Error(w(174));return e}function Ms(e,t){switch(Y(Fr,t),Y(Ar,e),Y(wt,Gr),e=t.nodeType,e){case 9:case 11:t=(t=t.documentElement)?t.namespaceURI:Pl(null,"");break;default:e=e===8?t.parentNode:t,t=e.namespaceURI||null,e=e.tagName,t=Pl(t,e)}Z(wt),Y(wt,t)}function Xn(){Z(wt),Z(Ar),Z(Fr)}function Bc(e){gn(Fr.current);var t=gn(wt.current),n=Pl(t,e.type);t!==n&&(Y(Ar,e),Y(wt,n))}function Ds(e){Ar.current===e&&(Z(wt),Z(Ar))}var te=sn(0);function ti(e){for(var t=e;t!==null;){if(t.tag===13){var n=t.memoizedState;if(n!==null&&(n=n.dehydrated,n===null||n.data==="$?"||n.data==="$!"))return t}else if(t.tag===19&&t.memoizedProps.revealOrder!==void 0){if((t.flags&128)!==0)return t}else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return null;t=t.return}t.sibling.return=t.return,t=t.sibling}return null}var cl=[];function Os(){for(var e=0;e<cl.length;e++)cl[e]._workInProgressVersionPrimary=null;cl.length=0}var Lo=Mt.ReactCurrentDispatcher,dl=Mt.ReactCurrentBatchConfig,xn=0,ne=null,pe=null,he=null,ni=!1,Sr=!1,jr=0,Sg=0;function ze(){throw Error(w(321))}function As(e,t){if(t===null)return!1;for(var n=0;n<t.length&&n<e.length;n++)if(!gt(e[n],t[n]))return!1;return!0}function Fs(e,t,n,r,o,i){if(xn=i,ne=t,t.memoizedState=null,t.updateQueue=null,t.lanes=0,Lo.current=e===null||e.memoizedState===null?Ng:Pg,e=n(r,o),Sr){i=0;do{if(Sr=!1,jr=0,25<=i)throw Error(w(301));i+=1,he=pe=null,t.updateQueue=null,Lo.current=zg,e=n(r,o)}while(Sr)}if(Lo.current=ri,t=pe!==null&&pe.next!==null,xn=0,he=pe=ne=null,ni=!1,t)throw Error(w(300));return e}function js(){var e=jr!==0;return jr=0,e}function vt(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return he===null?ne.memoizedState=he=e:he=he.next=e,he}function rt(){if(pe===null){var e=ne.alternate;e=e!==null?e.memoizedState:null}else e=pe.next;var t=he===null?ne.memoizedState:he.next;if(t!==null)he=t,pe=e;else{if(e===null)throw Error(w(310));pe=e,e={memoizedState:pe.memoizedState,baseState:pe.baseState,baseQueue:pe.baseQueue,queue:pe.queue,next:null},he===null?ne.memoizedState=he=e:he=he.next=e}return he}function $r(e,t){return typeof t=="function"?t(e):t}function pl(e){var t=rt(),n=t.queue;if(n===null)throw Error(w(311));n.lastRenderedReducer=e;var r=pe,o=r.baseQueue,i=n.pending;if(i!==null){if(o!==null){var l=o.next;o.next=i.next,i.next=l}r.baseQueue=o=i,n.pending=null}if(o!==null){i=o.next,r=r.baseState;var s=l=null,a=null,c=i;do{var m=c.lane;if((xn&m)===m)a!==null&&(a=a.next={lane:0,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null}),r=c.hasEagerState?c.eagerState:e(r,c.action);else{var g={lane:m,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null};a===null?(s=a=g,l=r):a=a.next=g,ne.lanes|=m,wn|=m}c=c.next}while(c!==null&&c!==i);a===null?l=r:a.next=s,gt(r,t.memoizedState)||($e=!0),t.memoizedState=r,t.baseState=l,t.baseQueue=a,n.lastRenderedState=r}if(e=n.interleaved,e!==null){o=e;do i=o.lane,ne.lanes|=i,wn|=i,o=o.next;while(o!==e)}else o===null&&(n.lanes=0);return[t.memoizedState,n.dispatch]}function fl(e){var t=rt(),n=t.queue;if(n===null)throw Error(w(311));n.lastRenderedReducer=e;var r=n.dispatch,o=n.pending,i=t.memoizedState;if(o!==null){n.pending=null;var l=o=o.next;do i=e(i,l.action),l=l.next;while(l!==o);gt(i,t.memoizedState)||($e=!0),t.memoizedState=i,t.baseQueue===null&&(t.baseState=i),n.lastRenderedState=i}return[i,r]}function Wc(){}function Vc(e,t){var n=ne,r=rt(),o=t(),i=!gt(r.memoizedState,o);if(i&&(r.memoizedState=o,$e=!0),r=r.queue,$s(Kc.bind(null,n,r,e),[e]),r.getSnapshot!==t||i||he!==null&&he.memoizedState.tag&1){if(n.flags|=2048,Ur(9,Qc.bind(null,n,r,o,t),void 0,null),ve===null)throw Error(w(349));(xn&30)!==0||Gc(n,t,o)}return o}function Gc(e,t,n){e.flags|=16384,e={getSnapshot:t,value:n},t=ne.updateQueue,t===null?(t={lastEffect:null,stores:null},ne.updateQueue=t,t.stores=[e]):(n=t.stores,n===null?t.stores=[e]:n.push(e))}function Qc(e,t,n,r){t.value=n,t.getSnapshot=r,Yc(t)&&Xc(e)}function Kc(e,t,n){return n(function(){Yc(t)&&Xc(e)})}function Yc(e){var t=e.getSnapshot;e=e.value;try{var n=t();return!gt(e,n)}catch{return!0}}function Xc(e){var t=Tt(e,1);t!==null&&ft(t,e,1,-1)}function yu(e){var t=vt();return typeof e=="function"&&(e=e()),t.memoizedState=t.baseState=e,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:$r,lastRenderedState:e},t.queue=e,e=e.dispatch=Eg.bind(null,ne,e),[t.memoizedState,e]}function Ur(e,t,n,r){return e={tag:e,create:t,destroy:n,deps:r,next:null},t=ne.updateQueue,t===null?(t={lastEffect:null,stores:null},ne.updateQueue=t,t.lastEffect=e.next=e):(n=t.lastEffect,n===null?t.lastEffect=e.next=e:(r=n.next,n.next=e,e.next=r,t.lastEffect=e)),e}function Zc(){return rt().memoizedState}function Mo(e,t,n,r){var o=vt();ne.flags|=e,o.memoizedState=Ur(1|t,n,void 0,r===void 0?null:r)}function mi(e,t,n,r){var o=rt();r=r===void 0?null:r;var i=void 0;if(pe!==null){var l=pe.memoizedState;if(i=l.destroy,r!==null&&As(r,l.deps)){o.memoizedState=Ur(t,n,i,r);return}}ne.flags|=e,o.memoizedState=Ur(1|t,n,i,r)}function xu(e,t){return Mo(8390656,8,e,t)}function $s(e,t){return mi(2048,8,e,t)}function Jc(e,t){return mi(4,2,e,t)}function qc(e,t){return mi(4,4,e,t)}function ed(e,t){if(typeof t=="function")return e=e(),t(e),function(){t(null)};if(t!=null)return e=e(),t.current=e,function(){t.current=null}}function td(e,t,n){return n=n!=null?n.concat([e]):null,mi(4,4,ed.bind(null,t,e),n)}function Us(){}function nd(e,t){var n=rt();t=t===void 0?null:t;var r=n.memoizedState;return r!==null&&t!==null&&As(t,r[1])?r[0]:(n.memoizedState=[e,t],e)}function rd(e,t){var n=rt();t=t===void 0?null:t;var r=n.memoizedState;return r!==null&&t!==null&&As(t,r[1])?r[0]:(e=e(),n.memoizedState=[e,t],e)}function od(e,t,n){return(xn&21)===0?(e.baseState&&(e.baseState=!1,$e=!0),e.memoizedState=n):(gt(n,t)||(n=uc(),ne.lanes|=n,wn|=n,e.baseState=!0),t)}function bg(e,t){var n=G;G=n!==0&&4>n?n:4,e(!0);var r=dl.transition;dl.transition={};try{e(!1),t()}finally{G=n,dl.transition=r}}function id(){return rt().memoizedState}function Cg(e,t,n){var r=tn(e);if(n={lane:r,action:n,hasEagerState:!1,eagerState:null,next:null},ld(e))sd(t,n);else if(n=Uc(e,t,n,r),n!==null){var o=Oe();ft(n,e,r,o),ad(n,t,r)}}function Eg(e,t,n){var r=tn(e),o={lane:r,action:n,hasEagerState:!1,eagerState:null,next:null};if(ld(e))sd(t,o);else{var i=e.alternate;if(e.lanes===0&&(i===null||i.lanes===0)&&(i=t.lastRenderedReducer,i!==null))try{var l=t.lastRenderedState,s=i(l,n);if(o.hasEagerState=!0,o.eagerState=s,gt(s,l)){var a=t.interleaved;a===null?(o.next=o,Ts(t)):(o.next=a.next,a.next=o),t.interleaved=o;return}}catch{}n=Uc(e,t,o,r),n!==null&&(o=Oe(),ft(n,e,r,o),ad(n,t,r))}}function ld(e){var t=e.alternate;return e===ne||t!==null&&t===ne}function sd(e,t){Sr=ni=!0;var n=e.pending;n===null?t.next=t:(t.next=n.next,n.next=t),e.pending=t}function ad(e,t,n){if((n&4194240)!==0){var r=t.lanes;r&=e.pendingLanes,n|=r,t.lanes=n,ys(e,n)}}var ri={readContext:nt,useCallback:ze,useContext:ze,useEffect:ze,useImperativeHandle:ze,useInsertionEffect:ze,useLayoutEffect:ze,useMemo:ze,useReducer:ze,useRef:ze,useState:ze,useDebugValue:ze,useDeferredValue:ze,useTransition:ze,useMutableSource:ze,useSyncExternalStore:ze,useId:ze,unstable_isNewReconciler:!1},Ng={readContext:nt,useCallback:function(e,t){return vt().memoizedState=[e,t===void 0?null:t],e},useContext:nt,useEffect:xu,useImperativeHandle:function(e,t,n){return n=n!=null?n.concat([e]):null,Mo(4194308,4,ed.bind(null,t,e),n)},useLayoutEffect:function(e,t){return Mo(4194308,4,e,t)},useInsertionEffect:function(e,t){return Mo(4,2,e,t)},useMemo:function(e,t){var n=vt();return t=t===void 0?null:t,e=e(),n.memoizedState=[e,t],e},useReducer:function(e,t,n){var r=vt();return t=n!==void 0?n(t):t,r.memoizedState=r.baseState=t,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:t},r.queue=e,e=e.dispatch=Cg.bind(null,ne,e),[r.memoizedState,e]},useRef:function(e){var t=vt();return e={current:e},t.memoizedState=e},useState:yu,useDebugValue:Us,useDeferredValue:function(e){return vt().memoizedState=e},useTransition:function(){var e=yu(!1),t=e[0];return e=bg.bind(null,e[1]),vt().memoizedState=e,[t,e]},useMutableSource:function(){},useSyncExternalStore:function(e,t,n){var r=ne,o=vt();if(J){if(n===void 0)throw Error(w(407));n=n()}else{if(n=t(),ve===null)throw Error(w(349));(xn&30)!==0||Gc(r,t,n)}o.memoizedState=n;var i={value:n,getSnapshot:t};return o.queue=i,xu(Kc.bind(null,r,i,e),[e]),r.flags|=2048,Ur(9,Qc.bind(null,r,i,n,t),void 0,null),n},useId:function(){var e=vt(),t=ve.identifierPrefix;if(J){var n=zt,r=Pt;n=(r&~(1<<32-pt(r)-1)).toString(32)+n,t=":"+t+"R"+n,n=jr++,0<n&&(t+="H"+n.toString(32)),t+=":"}else n=Sg++,t=":"+t+"r"+n.toString(32)+":";return e.memoizedState=t},unstable_isNewReconciler:!1},Pg={readContext:nt,useCallback:nd,useContext:nt,useEffect:$s,useImperativeHandle:td,useInsertionEffect:Jc,useLayoutEffect:qc,useMemo:rd,useReducer:pl,useRef:Zc,useState:function(){return pl($r)},useDebugValue:Us,useDeferredValue:function(e){var t=rt();return od(t,pe.memoizedState,e)},useTransition:function(){var e=pl($r)[0],t=rt().memoizedState;return[e,t]},useMutableSource:Wc,useSyncExternalStore:Vc,useId:id,unstable_isNewReconciler:!1},zg={readContext:nt,useCallback:nd,useContext:nt,useEffect:$s,useImperativeHandle:td,useInsertionEffect:Jc,useLayoutEffect:qc,useMemo:rd,useReducer:fl,useRef:Zc,useState:function(){return fl($r)},useDebugValue:Us,useDeferredValue:function(e){var t=rt();return pe===null?t.memoizedState=e:od(t,pe.memoizedState,e)},useTransition:function(){var e=fl($r)[0],t=rt().memoizedState;return[e,t]},useMutableSource:Wc,useSyncExternalStore:Vc,useId:id,unstable_isNewReconciler:!1};function ut(e,t){if(e&&e.defaultProps){t=re({},t),e=e.defaultProps;for(var n in e)t[n]===void 0&&(t[n]=e[n]);return t}return t}function Kl(e,t,n,r){t=e.memoizedState,n=n(r,t),n=n==null?t:re({},t,n),e.memoizedState=n,e.lanes===0&&(e.updateQueue.baseState=n)}var hi={isMounted:function(e){return(e=e._reactInternals)?bn(e)===e:!1},enqueueSetState:function(e,t,n){e=e._reactInternals;var r=Oe(),o=tn(e),i=_t(r,o);i.payload=t,n!=null&&(i.callback=n),t=qt(e,i,o),t!==null&&(ft(t,e,o,r),To(t,e,o))},enqueueReplaceState:function(e,t,n){e=e._reactInternals;var r=Oe(),o=tn(e),i=_t(r,o);i.tag=1,i.payload=t,n!=null&&(i.callback=n),t=qt(e,i,o),t!==null&&(ft(t,e,o,r),To(t,e,o))},enqueueForceUpdate:function(e,t){e=e._reactInternals;var n=Oe(),r=tn(e),o=_t(n,r);o.tag=2,t!=null&&(o.callback=t),t=qt(e,o,r),t!==null&&(ft(t,e,r,n),To(t,e,r))}};function wu(e,t,n,r,o,i,l){return e=e.stateNode,typeof e.shouldComponentUpdate=="function"?e.shouldComponentUpdate(r,i,l):t.prototype&&t.prototype.isPureReactComponent?!Lr(n,r)||!Lr(o,i):!0}function ud(e,t,n){var r=!1,o=on,i=t.contextType;return typeof i=="object"&&i!==null?i=nt(i):(o=He(t)?vn:Re.current,r=t.contextTypes,i=(r=r!=null)?Qn(e,o):on),t=new t(n,i),e.memoizedState=t.state!==null&&t.state!==void 0?t.state:null,t.updater=hi,e.stateNode=t,t._reactInternals=e,r&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=o,e.__reactInternalMemoizedMaskedChildContext=i),t}function ku(e,t,n,r){e=t.state,typeof t.componentWillReceiveProps=="function"&&t.componentWillReceiveProps(n,r),typeof t.UNSAFE_componentWillReceiveProps=="function"&&t.UNSAFE_componentWillReceiveProps(n,r),t.state!==e&&hi.enqueueReplaceState(t,t.state,null)}function Yl(e,t,n,r){var o=e.stateNode;o.props=n,o.state=e.memoizedState,o.refs={},Ls(e);var i=t.contextType;typeof i=="object"&&i!==null?o.context=nt(i):(i=He(t)?vn:Re.current,o.context=Qn(e,i)),o.state=e.memoizedState,i=t.getDerivedStateFromProps,typeof i=="function"&&(Kl(e,t,i,n),o.state=e.memoizedState),typeof t.getDerivedStateFromProps=="function"||typeof o.getSnapshotBeforeUpdate=="function"||typeof o.UNSAFE_componentWillMount!="function"&&typeof o.componentWillMount!="function"||(t=o.state,typeof o.componentWillMount=="function"&&o.componentWillMount(),typeof o.UNSAFE_componentWillMount=="function"&&o.UNSAFE_componentWillMount(),t!==o.state&&hi.enqueueReplaceState(o,o.state,null),ei(e,n,o,r),o.state=e.memoizedState),typeof o.componentDidMount=="function"&&(e.flags|=4194308)}function Zn(e,t){try{var n="",r=t;do n+=rf(r),r=r.return;while(r);var o=n}catch(i){o=`
Error generating stack: `+i.message+`
`+i.stack}return{value:e,source:t,stack:o,digest:null}}function gl(e,t,n){return{value:e,source:null,stack:n??null,digest:t??null}}function Xl(e,t){try{console.error(t.value)}catch(n){setTimeout(function(){throw n})}}var _g=typeof WeakMap=="function"?WeakMap:Map;function cd(e,t,n){n=_t(-1,n),n.tag=3,n.payload={element:null};var r=t.value;return n.callback=function(){ii||(ii=!0,ls=r),Xl(e,t)},n}function dd(e,t,n){n=_t(-1,n),n.tag=3;var r=e.type.getDerivedStateFromError;if(typeof r=="function"){var o=t.value;n.payload=function(){return r(o)},n.callback=function(){Xl(e,t)}}var i=e.stateNode;return i!==null&&typeof i.componentDidCatch=="function"&&(n.callback=function(){Xl(e,t),typeof r!="function"&&(en===null?en=new Set([this]):en.add(this));var l=t.stack;this.componentDidCatch(t.value,{componentStack:l!==null?l:""})}),n}function Su(e,t,n){var r=e.pingCache;if(r===null){r=e.pingCache=new _g;var o=new Set;r.set(t,o)}else o=r.get(t),o===void 0&&(o=new Set,r.set(t,o));o.has(n)||(o.add(n),e=Bg.bind(null,e,t,n),t.then(e,e))}function bu(e){do{var t;if((t=e.tag===13)&&(t=e.memoizedState,t=t!==null?t.dehydrated!==null:!0),t)return e;e=e.return}while(e!==null);return null}function Cu(e,t,n,r,o){return(e.mode&1)===0?(e===t?e.flags|=65536:(e.flags|=128,n.flags|=131072,n.flags&=-52805,n.tag===1&&(n.alternate===null?n.tag=17:(t=_t(-1,1),t.tag=2,qt(n,t,1))),n.lanes|=1),e):(e.flags|=65536,e.lanes=o,e)}var Ig=Mt.ReactCurrentOwner,$e=!1;function De(e,t,n,r){t.child=e===null?$c(t,null,n,r):Yn(t,e.child,n,r)}function Eu(e,t,n,r,o){n=n.render;var i=t.ref;return Wn(t,o),r=Fs(e,t,n,r,i,o),n=js(),e!==null&&!$e?(t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~o,Lt(e,t,o)):(J&&n&&Ns(t),t.flags|=1,De(e,t,r,o),t.child)}function Nu(e,t,n,r,o){if(e===null){var i=n.type;return typeof i=="function"&&!Ys(i)&&i.defaultProps===void 0&&n.compare===null&&n.defaultProps===void 0?(t.tag=15,t.type=i,pd(e,t,i,r,o)):(e=Fo(n.type,null,r,t,t.mode,o),e.ref=t.ref,e.return=t,t.child=e)}if(i=e.child,(e.lanes&o)===0){var l=i.memoizedProps;if(n=n.compare,n=n!==null?n:Lr,n(l,r)&&e.ref===t.ref)return Lt(e,t,o)}return t.flags|=1,e=nn(i,r),e.ref=t.ref,e.return=t,t.child=e}function pd(e,t,n,r,o){if(e!==null){var i=e.memoizedProps;if(Lr(i,r)&&e.ref===t.ref)if($e=!1,t.pendingProps=r=i,(e.lanes&o)!==0)(e.flags&131072)!==0&&($e=!0);else return t.lanes=e.lanes,Lt(e,t,o)}return Zl(e,t,n,r,o)}function fd(e,t,n){var r=t.pendingProps,o=r.children,i=e!==null?e.memoizedState:null;if(r.mode==="hidden")if((t.mode&1)===0)t.memoizedState={baseLanes:0,cachePool:null,transitions:null},Y(jn,We),We|=n;else{if((n&1073741824)===0)return e=i!==null?i.baseLanes|n:n,t.lanes=t.childLanes=1073741824,t.memoizedState={baseLanes:e,cachePool:null,transitions:null},t.updateQueue=null,Y(jn,We),We|=e,null;t.memoizedState={baseLanes:0,cachePool:null,transitions:null},r=i!==null?i.baseLanes:n,Y(jn,We),We|=r}else i!==null?(r=i.baseLanes|n,t.memoizedState=null):r=n,Y(jn,We),We|=r;return De(e,t,o,n),t.child}function gd(e,t){var n=t.ref;(e===null&&n!==null||e!==null&&e.ref!==n)&&(t.flags|=512,t.flags|=2097152)}function Zl(e,t,n,r,o){var i=He(n)?vn:Re.current;return i=Qn(t,i),Wn(t,o),n=Fs(e,t,n,r,i,o),r=js(),e!==null&&!$e?(t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~o,Lt(e,t,o)):(J&&r&&Ns(t),t.flags|=1,De(e,t,n,o),t.child)}function Pu(e,t,n,r,o){if(He(n)){var i=!0;Yo(t)}else i=!1;if(Wn(t,o),t.stateNode===null)Do(e,t),ud(t,n,r),Yl(t,n,r,o),r=!0;else if(e===null){var l=t.stateNode,s=t.memoizedProps;l.props=s;var a=l.context,c=n.contextType;typeof c=="object"&&c!==null?c=nt(c):(c=He(n)?vn:Re.current,c=Qn(t,c));var m=n.getDerivedStateFromProps,g=typeof m=="function"||typeof l.getSnapshotBeforeUpdate=="function";g||typeof l.UNSAFE_componentWillReceiveProps!="function"&&typeof l.componentWillReceiveProps!="function"||(s!==r||a!==c)&&ku(t,l,r,c),Wt=!1;var p=t.memoizedState;l.state=p,ei(t,r,l,o),a=t.memoizedState,s!==r||p!==a||Ue.current||Wt?(typeof m=="function"&&(Kl(t,n,m,r),a=t.memoizedState),(s=Wt||wu(t,n,s,r,p,a,c))?(g||typeof l.UNSAFE_componentWillMount!="function"&&typeof l.componentWillMount!="function"||(typeof l.componentWillMount=="function"&&l.componentWillMount(),typeof l.UNSAFE_componentWillMount=="function"&&l.UNSAFE_componentWillMount()),typeof l.componentDidMount=="function"&&(t.flags|=4194308)):(typeof l.componentDidMount=="function"&&(t.flags|=4194308),t.memoizedProps=r,t.memoizedState=a),l.props=r,l.state=a,l.context=c,r=s):(typeof l.componentDidMount=="function"&&(t.flags|=4194308),r=!1)}else{l=t.stateNode,Hc(e,t),s=t.memoizedProps,c=t.type===t.elementType?s:ut(t.type,s),l.props=c,g=t.pendingProps,p=l.context,a=n.contextType,typeof a=="object"&&a!==null?a=nt(a):(a=He(n)?vn:Re.current,a=Qn(t,a));var v=n.getDerivedStateFromProps;(m=typeof v=="function"||typeof l.getSnapshotBeforeUpdate=="function")||typeof l.UNSAFE_componentWillReceiveProps!="function"&&typeof l.componentWillReceiveProps!="function"||(s!==g||p!==a)&&ku(t,l,r,a),Wt=!1,p=t.memoizedState,l.state=p,ei(t,r,l,o);var y=t.memoizedState;s!==g||p!==y||Ue.current||Wt?(typeof v=="function"&&(Kl(t,n,v,r),y=t.memoizedState),(c=Wt||wu(t,n,c,r,p,y,a)||!1)?(m||typeof l.UNSAFE_componentWillUpdate!="function"&&typeof l.componentWillUpdate!="function"||(typeof l.componentWillUpdate=="function"&&l.componentWillUpdate(r,y,a),typeof l.UNSAFE_componentWillUpdate=="function"&&l.UNSAFE_componentWillUpdate(r,y,a)),typeof l.componentDidUpdate=="function"&&(t.flags|=4),typeof l.getSnapshotBeforeUpdate=="function"&&(t.flags|=1024)):(typeof l.componentDidUpdate!="function"||s===e.memoizedProps&&p===e.memoizedState||(t.flags|=4),typeof l.getSnapshotBeforeUpdate!="function"||s===e.memoizedProps&&p===e.memoizedState||(t.flags|=1024),t.memoizedProps=r,t.memoizedState=y),l.props=r,l.state=y,l.context=a,r=c):(typeof l.componentDidUpdate!="function"||s===e.memoizedProps&&p===e.memoizedState||(t.flags|=4),typeof l.getSnapshotBeforeUpdate!="function"||s===e.memoizedProps&&p===e.memoizedState||(t.flags|=1024),r=!1)}return Jl(e,t,n,r,i,o)}function Jl(e,t,n,r,o,i){gd(e,t);var l=(t.flags&128)!==0;if(!r&&!l)return o&&pu(t,n,!1),Lt(e,t,i);r=t.stateNode,Ig.current=t;var s=l&&typeof n.getDerivedStateFromError!="function"?null:r.render();return t.flags|=1,e!==null&&l?(t.child=Yn(t,e.child,null,i),t.child=Yn(t,null,s,i)):De(e,t,s,i),t.memoizedState=r.state,o&&pu(t,n,!0),t.child}function md(e){var t=e.stateNode;t.pendingContext?du(e,t.pendingContext,t.pendingContext!==t.context):t.context&&du(e,t.context,!1),Ms(e,t.containerInfo)}function zu(e,t,n,r,o){return Kn(),zs(o),t.flags|=256,De(e,t,n,r),t.child}var ql={dehydrated:null,treeContext:null,retryLane:0};function es(e){return{baseLanes:e,cachePool:null,transitions:null}}function hd(e,t,n){var r=t.pendingProps,o=te.current,i=!1,l=(t.flags&128)!==0,s;if((s=l)||(s=e!==null&&e.memoizedState===null?!1:(o&2)!==0),s?(i=!0,t.flags&=-129):(e===null||e.memoizedState!==null)&&(o|=1),Y(te,o&1),e===null)return Gl(t),e=t.memoizedState,e!==null&&(e=e.dehydrated,e!==null)?((t.mode&1)===0?t.lanes=1:e.data==="$!"?t.lanes=8:t.lanes=1073741824,null):(l=r.children,e=r.fallback,i?(r=t.mode,i=t.child,l={mode:"hidden",children:l},(r&1)===0&&i!==null?(i.childLanes=0,i.pendingProps=l):i=xi(l,r,0,null),e=hn(e,r,n,null),i.return=t,e.return=t,i.sibling=e,t.child=i,t.child.memoizedState=es(n),t.memoizedState=ql,e):Hs(t,l));if(o=e.memoizedState,o!==null&&(s=o.dehydrated,s!==null))return Rg(e,t,l,r,s,o,n);if(i){i=r.fallback,l=t.mode,o=e.child,s=o.sibling;var a={mode:"hidden",children:r.children};return(l&1)===0&&t.child!==o?(r=t.child,r.childLanes=0,r.pendingProps=a,t.deletions=null):(r=nn(o,a),r.subtreeFlags=o.subtreeFlags&14680064),s!==null?i=nn(s,i):(i=hn(i,l,n,null),i.flags|=2),i.return=t,r.return=t,r.sibling=i,t.child=r,r=i,i=t.child,l=e.child.memoizedState,l=l===null?es(n):{baseLanes:l.baseLanes|n,cachePool:null,transitions:l.transitions},i.memoizedState=l,i.childLanes=e.childLanes&~n,t.memoizedState=ql,r}return i=e.child,e=i.sibling,r=nn(i,{mode:"visible",children:r.children}),(t.mode&1)===0&&(r.lanes=n),r.return=t,r.sibling=null,e!==null&&(n=t.deletions,n===null?(t.deletions=[e],t.flags|=16):n.push(e)),t.child=r,t.memoizedState=null,r}function Hs(e,t){return t=xi({mode:"visible",children:t},e.mode,0,null),t.return=e,e.child=t}function No(e,t,n,r){return r!==null&&zs(r),Yn(t,e.child,null,n),e=Hs(t,t.pendingProps.children),e.flags|=2,t.memoizedState=null,e}function Rg(e,t,n,r,o,i,l){if(n)return t.flags&256?(t.flags&=-257,r=gl(Error(w(422))),No(e,t,l,r)):t.memoizedState!==null?(t.child=e.child,t.flags|=128,null):(i=r.fallback,o=t.mode,r=xi({mode:"visible",children:r.children},o,0,null),i=hn(i,o,l,null),i.flags|=2,r.return=t,i.return=t,r.sibling=i,t.child=r,(t.mode&1)!==0&&Yn(t,e.child,null,l),t.child.memoizedState=es(l),t.memoizedState=ql,i);if((t.mode&1)===0)return No(e,t,l,null);if(o.data==="$!"){if(r=o.nextSibling&&o.nextSibling.dataset,r)var s=r.dgst;return r=s,i=Error(w(419)),r=gl(i,r,void 0),No(e,t,l,r)}if(s=(l&e.childLanes)!==0,$e||s){if(r=ve,r!==null){switch(l&-l){case 4:o=2;break;case 16:o=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:o=32;break;case 536870912:o=268435456;break;default:o=0}o=(o&(r.suspendedLanes|l))!==0?0:o,o!==0&&o!==i.retryLane&&(i.retryLane=o,Tt(e,o),ft(r,e,o,-1))}return Ks(),r=gl(Error(w(421))),No(e,t,l,r)}return o.data==="$?"?(t.flags|=128,t.child=e.child,t=Wg.bind(null,e),o._reactRetry=t,null):(e=i.treeContext,Ve=Jt(o.nextSibling),Ge=t,J=!0,dt=null,e!==null&&(Je[qe++]=Pt,Je[qe++]=zt,Je[qe++]=yn,Pt=e.id,zt=e.overflow,yn=t),t=Hs(t,r.children),t.flags|=4096,t)}function _u(e,t,n){e.lanes|=t;var r=e.alternate;r!==null&&(r.lanes|=t),Ql(e.return,t,n)}function ml(e,t,n,r,o){var i=e.memoizedState;i===null?e.memoizedState={isBackwards:t,rendering:null,renderingStartTime:0,last:r,tail:n,tailMode:o}:(i.isBackwards=t,i.rendering=null,i.renderingStartTime=0,i.last=r,i.tail=n,i.tailMode=o)}function vd(e,t,n){var r=t.pendingProps,o=r.revealOrder,i=r.tail;if(De(e,t,r.children,n),r=te.current,(r&2)!==0)r=r&1|2,t.flags|=128;else{if(e!==null&&(e.flags&128)!==0)e:for(e=t.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&_u(e,n,t);else if(e.tag===19)_u(e,n,t);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break e;for(;e.sibling===null;){if(e.return===null||e.return===t)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}r&=1}if(Y(te,r),(t.mode&1)===0)t.memoizedState=null;else switch(o){case"forwards":for(n=t.child,o=null;n!==null;)e=n.alternate,e!==null&&ti(e)===null&&(o=n),n=n.sibling;n=o,n===null?(o=t.child,t.child=null):(o=n.sibling,n.sibling=null),ml(t,!1,o,n,i);break;case"backwards":for(n=null,o=t.child,t.child=null;o!==null;){if(e=o.alternate,e!==null&&ti(e)===null){t.child=o;break}e=o.sibling,o.sibling=n,n=o,o=e}ml(t,!0,n,null,i);break;case"together":ml(t,!1,null,null,void 0);break;default:t.memoizedState=null}return t.child}function Do(e,t){(t.mode&1)===0&&e!==null&&(e.alternate=null,t.alternate=null,t.flags|=2)}function Lt(e,t,n){if(e!==null&&(t.dependencies=e.dependencies),wn|=t.lanes,(n&t.childLanes)===0)return null;if(e!==null&&t.child!==e.child)throw Error(w(153));if(t.child!==null){for(e=t.child,n=nn(e,e.pendingProps),t.child=n,n.return=t;e.sibling!==null;)e=e.sibling,n=n.sibling=nn(e,e.pendingProps),n.return=t;n.sibling=null}return t.child}function Tg(e,t,n){switch(t.tag){case 3:md(t),Kn();break;case 5:Bc(t);break;case 1:He(t.type)&&Yo(t);break;case 4:Ms(t,t.stateNode.containerInfo);break;case 10:var r=t.type._context,o=t.memoizedProps.value;Y(Jo,r._currentValue),r._currentValue=o;break;case 13:if(r=t.memoizedState,r!==null)return r.dehydrated!==null?(Y(te,te.current&1),t.flags|=128,null):(n&t.child.childLanes)!==0?hd(e,t,n):(Y(te,te.current&1),e=Lt(e,t,n),e!==null?e.sibling:null);Y(te,te.current&1);break;case 19:if(r=(n&t.childLanes)!==0,(e.flags&128)!==0){if(r)return vd(e,t,n);t.flags|=128}if(o=t.memoizedState,o!==null&&(o.rendering=null,o.tail=null,o.lastEffect=null),Y(te,te.current),r)break;return null;case 22:case 23:return t.lanes=0,fd(e,t,n)}return Lt(e,t,n)}var yd,ts,xd,wd;yd=function(e,t){for(var n=t.child;n!==null;){if(n.tag===5||n.tag===6)e.appendChild(n.stateNode);else if(n.tag!==4&&n.child!==null){n.child.return=n,n=n.child;continue}if(n===t)break;for(;n.sibling===null;){if(n.return===null||n.return===t)return;n=n.return}n.sibling.return=n.return,n=n.sibling}};ts=function(){};xd=function(e,t,n,r){var o=e.memoizedProps;if(o!==r){e=t.stateNode,gn(wt.current);var i=null;switch(n){case"input":o=bl(e,o),r=bl(e,r),i=[];break;case"select":o=re({},o,{value:void 0}),r=re({},r,{value:void 0}),i=[];break;case"textarea":o=Nl(e,o),r=Nl(e,r),i=[];break;default:typeof o.onClick!="function"&&typeof r.onClick=="function"&&(e.onclick=Qo)}zl(n,r);var l;n=null;for(c in o)if(!r.hasOwnProperty(c)&&o.hasOwnProperty(c)&&o[c]!=null)if(c==="style"){var s=o[c];for(l in s)s.hasOwnProperty(l)&&(n||(n={}),n[l]="")}else c!=="dangerouslySetInnerHTML"&&c!=="children"&&c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&c!=="autoFocus"&&(Nr.hasOwnProperty(c)?i||(i=[]):(i=i||[]).push(c,null));for(c in r){var a=r[c];if(s=o?.[c],r.hasOwnProperty(c)&&a!==s&&(a!=null||s!=null))if(c==="style")if(s){for(l in s)!s.hasOwnProperty(l)||a&&a.hasOwnProperty(l)||(n||(n={}),n[l]="");for(l in a)a.hasOwnProperty(l)&&s[l]!==a[l]&&(n||(n={}),n[l]=a[l])}else n||(i||(i=[]),i.push(c,n)),n=a;else c==="dangerouslySetInnerHTML"?(a=a?a.__html:void 0,s=s?s.__html:void 0,a!=null&&s!==a&&(i=i||[]).push(c,a)):c==="children"?typeof a!="string"&&typeof a!="number"||(i=i||[]).push(c,""+a):c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&(Nr.hasOwnProperty(c)?(a!=null&&c==="onScroll"&&X("scroll",e),i||s===a||(i=[])):(i=i||[]).push(c,a))}n&&(i=i||[]).push("style",n);var c=i;(t.updateQueue=c)&&(t.flags|=4)}};wd=function(e,t,n,r){n!==r&&(t.flags|=4)};function cr(e,t){if(!J)switch(e.tailMode){case"hidden":t=e.tail;for(var n=null;t!==null;)t.alternate!==null&&(n=t),t=t.sibling;n===null?e.tail=null:n.sibling=null;break;case"collapsed":n=e.tail;for(var r=null;n!==null;)n.alternate!==null&&(r=n),n=n.sibling;r===null?t||e.tail===null?e.tail=null:e.tail.sibling=null:r.sibling=null}}function _e(e){var t=e.alternate!==null&&e.alternate.child===e.child,n=0,r=0;if(t)for(var o=e.child;o!==null;)n|=o.lanes|o.childLanes,r|=o.subtreeFlags&14680064,r|=o.flags&14680064,o.return=e,o=o.sibling;else for(o=e.child;o!==null;)n|=o.lanes|o.childLanes,r|=o.subtreeFlags,r|=o.flags,o.return=e,o=o.sibling;return e.subtreeFlags|=r,e.childLanes=n,t}function Lg(e,t,n){var r=t.pendingProps;switch(Ps(t),t.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return _e(t),null;case 1:return He(t.type)&&Ko(),_e(t),null;case 3:return r=t.stateNode,Xn(),Z(Ue),Z(Re),Os(),r.pendingContext&&(r.context=r.pendingContext,r.pendingContext=null),(e===null||e.child===null)&&(Co(t)?t.flags|=4:e===null||e.memoizedState.isDehydrated&&(t.flags&256)===0||(t.flags|=1024,dt!==null&&(us(dt),dt=null))),ts(e,t),_e(t),null;case 5:Ds(t);var o=gn(Fr.current);if(n=t.type,e!==null&&t.stateNode!=null)xd(e,t,n,r,o),e.ref!==t.ref&&(t.flags|=512,t.flags|=2097152);else{if(!r){if(t.stateNode===null)throw Error(w(166));return _e(t),null}if(e=gn(wt.current),Co(t)){r=t.stateNode,n=t.type;var i=t.memoizedProps;switch(r[yt]=t,r[Or]=i,e=(t.mode&1)!==0,n){case"dialog":X("cancel",r),X("close",r);break;case"iframe":case"object":case"embed":X("load",r);break;case"video":case"audio":for(o=0;o<hr.length;o++)X(hr[o],r);break;case"source":X("error",r);break;case"img":case"image":case"link":X("error",r),X("load",r);break;case"details":X("toggle",r);break;case"input":Aa(r,i),X("invalid",r);break;case"select":r._wrapperState={wasMultiple:!!i.multiple},X("invalid",r);break;case"textarea":ja(r,i),X("invalid",r)}zl(n,i),o=null;for(var l in i)if(i.hasOwnProperty(l)){var s=i[l];l==="children"?typeof s=="string"?r.textContent!==s&&(i.suppressHydrationWarning!==!0&&bo(r.textContent,s,e),o=["children",s]):typeof s=="number"&&r.textContent!==""+s&&(i.suppressHydrationWarning!==!0&&bo(r.textContent,s,e),o=["children",""+s]):Nr.hasOwnProperty(l)&&s!=null&&l==="onScroll"&&X("scroll",r)}switch(n){case"input":co(r),Fa(r,i,!0);break;case"textarea":co(r),$a(r);break;case"select":case"option":break;default:typeof i.onClick=="function"&&(r.onclick=Qo)}r=o,t.updateQueue=r,r!==null&&(t.flags|=4)}else{l=o.nodeType===9?o:o.ownerDocument,e==="http://www.w3.org/1999/xhtml"&&(e=Ku(n)),e==="http://www.w3.org/1999/xhtml"?n==="script"?(e=l.createElement("div"),e.innerHTML="<script><\/script>",e=e.removeChild(e.firstChild)):typeof r.is=="string"?e=l.createElement(n,{is:r.is}):(e=l.createElement(n),n==="select"&&(l=e,r.multiple?l.multiple=!0:r.size&&(l.size=r.size))):e=l.createElementNS(e,n),e[yt]=t,e[Or]=r,yd(e,t,!1,!1),t.stateNode=e;e:{switch(l=_l(n,r),n){case"dialog":X("cancel",e),X("close",e),o=r;break;case"iframe":case"object":case"embed":X("load",e),o=r;break;case"video":case"audio":for(o=0;o<hr.length;o++)X(hr[o],e);o=r;break;case"source":X("error",e),o=r;break;case"img":case"image":case"link":X("error",e),X("load",e),o=r;break;case"details":X("toggle",e),o=r;break;case"input":Aa(e,r),o=bl(e,r),X("invalid",e);break;case"option":o=r;break;case"select":e._wrapperState={wasMultiple:!!r.multiple},o=re({},r,{value:void 0}),X("invalid",e);break;case"textarea":ja(e,r),o=Nl(e,r),X("invalid",e);break;default:o=r}zl(n,o),s=o;for(i in s)if(s.hasOwnProperty(i)){var a=s[i];i==="style"?Zu(e,a):i==="dangerouslySetInnerHTML"?(a=a?a.__html:void 0,a!=null&&Yu(e,a)):i==="children"?typeof a=="string"?(n!=="textarea"||a!=="")&&Pr(e,a):typeof a=="number"&&Pr(e,""+a):i!=="suppressContentEditableWarning"&&i!=="suppressHydrationWarning"&&i!=="autoFocus"&&(Nr.hasOwnProperty(i)?a!=null&&i==="onScroll"&&X("scroll",e):a!=null&&ps(e,i,a,l))}switch(n){case"input":co(e),Fa(e,r,!1);break;case"textarea":co(e),$a(e);break;case"option":r.value!=null&&e.setAttribute("value",""+rn(r.value));break;case"select":e.multiple=!!r.multiple,i=r.value,i!=null?$n(e,!!r.multiple,i,!1):r.defaultValue!=null&&$n(e,!!r.multiple,r.defaultValue,!0);break;default:typeof o.onClick=="function"&&(e.onclick=Qo)}switch(n){case"button":case"input":case"select":case"textarea":r=!!r.autoFocus;break e;case"img":r=!0;break e;default:r=!1}}r&&(t.flags|=4)}t.ref!==null&&(t.flags|=512,t.flags|=2097152)}return _e(t),null;case 6:if(e&&t.stateNode!=null)wd(e,t,e.memoizedProps,r);else{if(typeof r!="string"&&t.stateNode===null)throw Error(w(166));if(n=gn(Fr.current),gn(wt.current),Co(t)){if(r=t.stateNode,n=t.memoizedProps,r[yt]=t,(i=r.nodeValue!==n)&&(e=Ge,e!==null))switch(e.tag){case 3:bo(r.nodeValue,n,(e.mode&1)!==0);break;case 5:e.memoizedProps.suppressHydrationWarning!==!0&&bo(r.nodeValue,n,(e.mode&1)!==0)}i&&(t.flags|=4)}else r=(n.nodeType===9?n:n.ownerDocument).createTextNode(r),r[yt]=t,t.stateNode=r}return _e(t),null;case 13:if(Z(te),r=t.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(J&&Ve!==null&&(t.mode&1)!==0&&(t.flags&128)===0)Fc(),Kn(),t.flags|=98560,i=!1;else if(i=Co(t),r!==null&&r.dehydrated!==null){if(e===null){if(!i)throw Error(w(318));if(i=t.memoizedState,i=i!==null?i.dehydrated:null,!i)throw Error(w(317));i[yt]=t}else Kn(),(t.flags&128)===0&&(t.memoizedState=null),t.flags|=4;_e(t),i=!1}else dt!==null&&(us(dt),dt=null),i=!0;if(!i)return t.flags&65536?t:null}return(t.flags&128)!==0?(t.lanes=n,t):(r=r!==null,r!==(e!==null&&e.memoizedState!==null)&&r&&(t.child.flags|=8192,(t.mode&1)!==0&&(e===null||(te.current&1)!==0?fe===0&&(fe=3):Ks())),t.updateQueue!==null&&(t.flags|=4),_e(t),null);case 4:return Xn(),ts(e,t),e===null&&Mr(t.stateNode.containerInfo),_e(t),null;case 10:return Rs(t.type._context),_e(t),null;case 17:return He(t.type)&&Ko(),_e(t),null;case 19:if(Z(te),i=t.memoizedState,i===null)return _e(t),null;if(r=(t.flags&128)!==0,l=i.rendering,l===null)if(r)cr(i,!1);else{if(fe!==0||e!==null&&(e.flags&128)!==0)for(e=t.child;e!==null;){if(l=ti(e),l!==null){for(t.flags|=128,cr(i,!1),r=l.updateQueue,r!==null&&(t.updateQueue=r,t.flags|=4),t.subtreeFlags=0,r=n,n=t.child;n!==null;)i=n,e=r,i.flags&=14680066,l=i.alternate,l===null?(i.childLanes=0,i.lanes=e,i.child=null,i.subtreeFlags=0,i.memoizedProps=null,i.memoizedState=null,i.updateQueue=null,i.dependencies=null,i.stateNode=null):(i.childLanes=l.childLanes,i.lanes=l.lanes,i.child=l.child,i.subtreeFlags=0,i.deletions=null,i.memoizedProps=l.memoizedProps,i.memoizedState=l.memoizedState,i.updateQueue=l.updateQueue,i.type=l.type,e=l.dependencies,i.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),n=n.sibling;return Y(te,te.current&1|2),t.child}e=e.sibling}i.tail!==null&&ae()>Jn&&(t.flags|=128,r=!0,cr(i,!1),t.lanes=4194304)}else{if(!r)if(e=ti(l),e!==null){if(t.flags|=128,r=!0,n=e.updateQueue,n!==null&&(t.updateQueue=n,t.flags|=4),cr(i,!0),i.tail===null&&i.tailMode==="hidden"&&!l.alternate&&!J)return _e(t),null}else 2*ae()-i.renderingStartTime>Jn&&n!==1073741824&&(t.flags|=128,r=!0,cr(i,!1),t.lanes=4194304);i.isBackwards?(l.sibling=t.child,t.child=l):(n=i.last,n!==null?n.sibling=l:t.child=l,i.last=l)}return i.tail!==null?(t=i.tail,i.rendering=t,i.tail=t.sibling,i.renderingStartTime=ae(),t.sibling=null,n=te.current,Y(te,r?n&1|2:n&1),t):(_e(t),null);case 22:case 23:return Qs(),r=t.memoizedState!==null,e!==null&&e.memoizedState!==null!==r&&(t.flags|=8192),r&&(t.mode&1)!==0?(We&1073741824)!==0&&(_e(t),t.subtreeFlags&6&&(t.flags|=8192)):_e(t),null;case 24:return null;case 25:return null}throw Error(w(156,t.tag))}function Mg(e,t){switch(Ps(t),t.tag){case 1:return He(t.type)&&Ko(),e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 3:return Xn(),Z(Ue),Z(Re),Os(),e=t.flags,(e&65536)!==0&&(e&128)===0?(t.flags=e&-65537|128,t):null;case 5:return Ds(t),null;case 13:if(Z(te),e=t.memoizedState,e!==null&&e.dehydrated!==null){if(t.alternate===null)throw Error(w(340));Kn()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 19:return Z(te),null;case 4:return Xn(),null;case 10:return Rs(t.type._context),null;case 22:case 23:return Qs(),null;case 24:return null;default:return null}}var Po=!1,Ie=!1,Dg=typeof WeakSet=="function"?WeakSet:Set,N=null;function Fn(e,t){var n=e.ref;if(n!==null)if(typeof n=="function")try{n(null)}catch(r){le(e,t,r)}else n.current=null}function ns(e,t,n){try{n()}catch(r){le(e,t,r)}}var Iu=!1;function Og(e,t){if(jl=Wo,e=Ec(),Es(e)){if("selectionStart"in e)var n={start:e.selectionStart,end:e.selectionEnd};else e:{n=(n=e.ownerDocument)&&n.defaultView||window;var r=n.getSelection&&n.getSelection();if(r&&r.rangeCount!==0){n=r.anchorNode;var o=r.anchorOffset,i=r.focusNode;r=r.focusOffset;try{n.nodeType,i.nodeType}catch{n=null;break e}var l=0,s=-1,a=-1,c=0,m=0,g=e,p=null;t:for(;;){for(var v;g!==n||o!==0&&g.nodeType!==3||(s=l+o),g!==i||r!==0&&g.nodeType!==3||(a=l+r),g.nodeType===3&&(l+=g.nodeValue.length),(v=g.firstChild)!==null;)p=g,g=v;for(;;){if(g===e)break t;if(p===n&&++c===o&&(s=l),p===i&&++m===r&&(a=l),(v=g.nextSibling)!==null)break;g=p,p=g.parentNode}g=v}n=s===-1||a===-1?null:{start:s,end:a}}else n=null}n=n||{start:0,end:0}}else n=null;for($l={focusedElem:e,selectionRange:n},Wo=!1,N=t;N!==null;)if(t=N,e=t.child,(t.subtreeFlags&1028)!==0&&e!==null)e.return=t,N=e;else for(;N!==null;){t=N;try{var y=t.alternate;if((t.flags&1024)!==0)switch(t.tag){case 0:case 11:case 15:break;case 1:if(y!==null){var h=y.memoizedProps,I=y.memoizedState,d=t.stateNode,u=d.getSnapshotBeforeUpdate(t.elementType===t.type?h:ut(t.type,h),I);d.__reactInternalSnapshotBeforeUpdate=u}break;case 3:var f=t.stateNode.containerInfo;f.nodeType===1?f.textContent="":f.nodeType===9&&f.documentElement&&f.removeChild(f.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(w(163))}}catch(x){le(t,t.return,x)}if(e=t.sibling,e!==null){e.return=t.return,N=e;break}N=t.return}return y=Iu,Iu=!1,y}function br(e,t,n){var r=t.updateQueue;if(r=r!==null?r.lastEffect:null,r!==null){var o=r=r.next;do{if((o.tag&e)===e){var i=o.destroy;o.destroy=void 0,i!==void 0&&ns(t,n,i)}o=o.next}while(o!==r)}}function vi(e,t){if(t=t.updateQueue,t=t!==null?t.lastEffect:null,t!==null){var n=t=t.next;do{if((n.tag&e)===e){var r=n.create;n.destroy=r()}n=n.next}while(n!==t)}}function rs(e){var t=e.ref;if(t!==null){var n=e.stateNode;e.tag,e=n,typeof t=="function"?t(e):t.current=e}}function kd(e){var t=e.alternate;t!==null&&(e.alternate=null,kd(t)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(t=e.stateNode,t!==null&&(delete t[yt],delete t[Or],delete t[Bl],delete t[yg],delete t[xg])),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}function Sd(e){return e.tag===5||e.tag===3||e.tag===4}function Ru(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||Sd(e.return))return null;e=e.return}for(e.sibling.return=e.return,e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.flags&2||e.child===null||e.tag===4)continue e;e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function os(e,t,n){var r=e.tag;if(r===5||r===6)e=e.stateNode,t?n.nodeType===8?n.parentNode.insertBefore(e,t):n.insertBefore(e,t):(n.nodeType===8?(t=n.parentNode,t.insertBefore(e,n)):(t=n,t.appendChild(e)),n=n._reactRootContainer,n!=null||t.onclick!==null||(t.onclick=Qo));else if(r!==4&&(e=e.child,e!==null))for(os(e,t,n),e=e.sibling;e!==null;)os(e,t,n),e=e.sibling}function is(e,t,n){var r=e.tag;if(r===5||r===6)e=e.stateNode,t?n.insertBefore(e,t):n.appendChild(e);else if(r!==4&&(e=e.child,e!==null))for(is(e,t,n),e=e.sibling;e!==null;)is(e,t,n),e=e.sibling}var we=null,ct=!1;function Ht(e,t,n){for(n=n.child;n!==null;)bd(e,t,n),n=n.sibling}function bd(e,t,n){if(xt&&typeof xt.onCommitFiberUnmount=="function")try{xt.onCommitFiberUnmount(ui,n)}catch{}switch(n.tag){case 5:Ie||Fn(n,t);case 6:var r=we,o=ct;we=null,Ht(e,t,n),we=r,ct=o,we!==null&&(ct?(e=we,n=n.stateNode,e.nodeType===8?e.parentNode.removeChild(n):e.removeChild(n)):we.removeChild(n.stateNode));break;case 18:we!==null&&(ct?(e=we,n=n.stateNode,e.nodeType===8?al(e.parentNode,n):e.nodeType===1&&al(e,n),Rr(e)):al(we,n.stateNode));break;case 4:r=we,o=ct,we=n.stateNode.containerInfo,ct=!0,Ht(e,t,n),we=r,ct=o;break;case 0:case 11:case 14:case 15:if(!Ie&&(r=n.updateQueue,r!==null&&(r=r.lastEffect,r!==null))){o=r=r.next;do{var i=o,l=i.destroy;i=i.tag,l!==void 0&&((i&2)!==0||(i&4)!==0)&&ns(n,t,l),o=o.next}while(o!==r)}Ht(e,t,n);break;case 1:if(!Ie&&(Fn(n,t),r=n.stateNode,typeof r.componentWillUnmount=="function"))try{r.props=n.memoizedProps,r.state=n.memoizedState,r.componentWillUnmount()}catch(s){le(n,t,s)}Ht(e,t,n);break;case 21:Ht(e,t,n);break;case 22:n.mode&1?(Ie=(r=Ie)||n.memoizedState!==null,Ht(e,t,n),Ie=r):Ht(e,t,n);break;default:Ht(e,t,n)}}function Tu(e){var t=e.updateQueue;if(t!==null){e.updateQueue=null;var n=e.stateNode;n===null&&(n=e.stateNode=new Dg),t.forEach(function(r){var o=Vg.bind(null,e,r);n.has(r)||(n.add(r),r.then(o,o))})}}function at(e,t){var n=t.deletions;if(n!==null)for(var r=0;r<n.length;r++){var o=n[r];try{var i=e,l=t,s=l;e:for(;s!==null;){switch(s.tag){case 5:we=s.stateNode,ct=!1;break e;case 3:we=s.stateNode.containerInfo,ct=!0;break e;case 4:we=s.stateNode.containerInfo,ct=!0;break e}s=s.return}if(we===null)throw Error(w(160));bd(i,l,o),we=null,ct=!1;var a=o.alternate;a!==null&&(a.return=null),o.return=null}catch(c){le(o,t,c)}}if(t.subtreeFlags&12854)for(t=t.child;t!==null;)Cd(t,e),t=t.sibling}function Cd(e,t){var n=e.alternate,r=e.flags;switch(e.tag){case 0:case 11:case 14:case 15:if(at(t,e),ht(e),r&4){try{br(3,e,e.return),vi(3,e)}catch(h){le(e,e.return,h)}try{br(5,e,e.return)}catch(h){le(e,e.return,h)}}break;case 1:at(t,e),ht(e),r&512&&n!==null&&Fn(n,n.return);break;case 5:if(at(t,e),ht(e),r&512&&n!==null&&Fn(n,n.return),e.flags&32){var o=e.stateNode;try{Pr(o,"")}catch(h){le(e,e.return,h)}}if(r&4&&(o=e.stateNode,o!=null)){var i=e.memoizedProps,l=n!==null?n.memoizedProps:i,s=e.type,a=e.updateQueue;if(e.updateQueue=null,a!==null)try{s==="input"&&i.type==="radio"&&i.name!=null&&Gu(o,i),_l(s,l);var c=_l(s,i);for(l=0;l<a.length;l+=2){var m=a[l],g=a[l+1];m==="style"?Zu(o,g):m==="dangerouslySetInnerHTML"?Yu(o,g):m==="children"?Pr(o,g):ps(o,m,g,c)}switch(s){case"input":Cl(o,i);break;case"textarea":Qu(o,i);break;case"select":var p=o._wrapperState.wasMultiple;o._wrapperState.wasMultiple=!!i.multiple;var v=i.value;v!=null?$n(o,!!i.multiple,v,!1):p!==!!i.multiple&&(i.defaultValue!=null?$n(o,!!i.multiple,i.defaultValue,!0):$n(o,!!i.multiple,i.multiple?[]:"",!1))}o[Or]=i}catch(h){le(e,e.return,h)}}break;case 6:if(at(t,e),ht(e),r&4){if(e.stateNode===null)throw Error(w(162));o=e.stateNode,i=e.memoizedProps;try{o.nodeValue=i}catch(h){le(e,e.return,h)}}break;case 3:if(at(t,e),ht(e),r&4&&n!==null&&n.memoizedState.isDehydrated)try{Rr(t.containerInfo)}catch(h){le(e,e.return,h)}break;case 4:at(t,e),ht(e);break;case 13:at(t,e),ht(e),o=e.child,o.flags&8192&&(i=o.memoizedState!==null,o.stateNode.isHidden=i,!i||o.alternate!==null&&o.alternate.memoizedState!==null||(Vs=ae())),r&4&&Tu(e);break;case 22:if(m=n!==null&&n.memoizedState!==null,e.mode&1?(Ie=(c=Ie)||m,at(t,e),Ie=c):at(t,e),ht(e),r&8192){if(c=e.memoizedState!==null,(e.stateNode.isHidden=c)&&!m&&(e.mode&1)!==0)for(N=e,m=e.child;m!==null;){for(g=N=m;N!==null;){switch(p=N,v=p.child,p.tag){case 0:case 11:case 14:case 15:br(4,p,p.return);break;case 1:Fn(p,p.return);var y=p.stateNode;if(typeof y.componentWillUnmount=="function"){r=p,n=p.return;try{t=r,y.props=t.memoizedProps,y.state=t.memoizedState,y.componentWillUnmount()}catch(h){le(r,n,h)}}break;case 5:Fn(p,p.return);break;case 22:if(p.memoizedState!==null){Mu(g);continue}}v!==null?(v.return=p,N=v):Mu(g)}m=m.sibling}e:for(m=null,g=e;;){if(g.tag===5){if(m===null){m=g;try{o=g.stateNode,c?(i=o.style,typeof i.setProperty=="function"?i.setProperty("display","none","important"):i.display="none"):(s=g.stateNode,a=g.memoizedProps.style,l=a!=null&&a.hasOwnProperty("display")?a.display:null,s.style.display=Xu("display",l))}catch(h){le(e,e.return,h)}}}else if(g.tag===6){if(m===null)try{g.stateNode.nodeValue=c?"":g.memoizedProps}catch(h){le(e,e.return,h)}}else if((g.tag!==22&&g.tag!==23||g.memoizedState===null||g===e)&&g.child!==null){g.child.return=g,g=g.child;continue}if(g===e)break e;for(;g.sibling===null;){if(g.return===null||g.return===e)break e;m===g&&(m=null),g=g.return}m===g&&(m=null),g.sibling.return=g.return,g=g.sibling}}break;case 19:at(t,e),ht(e),r&4&&Tu(e);break;case 21:break;default:at(t,e),ht(e)}}function ht(e){var t=e.flags;if(t&2){try{e:{for(var n=e.return;n!==null;){if(Sd(n)){var r=n;break e}n=n.return}throw Error(w(160))}switch(r.tag){case 5:var o=r.stateNode;r.flags&32&&(Pr(o,""),r.flags&=-33);var i=Ru(e);is(e,i,o);break;case 3:case 4:var l=r.stateNode.containerInfo,s=Ru(e);os(e,s,l);break;default:throw Error(w(161))}}catch(a){le(e,e.return,a)}e.flags&=-3}t&4096&&(e.flags&=-4097)}function Ag(e,t,n){N=e,Ed(e,t,n)}function Ed(e,t,n){for(var r=(e.mode&1)!==0;N!==null;){var o=N,i=o.child;if(o.tag===22&&r){var l=o.memoizedState!==null||Po;if(!l){var s=o.alternate,a=s!==null&&s.memoizedState!==null||Ie;s=Po;var c=Ie;if(Po=l,(Ie=a)&&!c)for(N=o;N!==null;)l=N,a=l.child,l.tag===22&&l.memoizedState!==null?Du(o):a!==null?(a.return=l,N=a):Du(o);for(;i!==null;)N=i,Ed(i,t,n),i=i.sibling;N=o,Po=s,Ie=c}Lu(e,t,n)}else(o.subtreeFlags&8772)!==0&&i!==null?(i.return=o,N=i):Lu(e,t,n)}}function Lu(e){for(;N!==null;){var t=N;if((t.flags&8772)!==0){var n=t.alternate;try{if((t.flags&8772)!==0)switch(t.tag){case 0:case 11:case 15:Ie||vi(5,t);break;case 1:var r=t.stateNode;if(t.flags&4&&!Ie)if(n===null)r.componentDidMount();else{var o=t.elementType===t.type?n.memoizedProps:ut(t.type,n.memoizedProps);r.componentDidUpdate(o,n.memoizedState,r.__reactInternalSnapshotBeforeUpdate)}var i=t.updateQueue;i!==null&&vu(t,i,r);break;case 3:var l=t.updateQueue;if(l!==null){if(n=null,t.child!==null)switch(t.child.tag){case 5:n=t.child.stateNode;break;case 1:n=t.child.stateNode}vu(t,l,n)}break;case 5:var s=t.stateNode;if(n===null&&t.flags&4){n=s;var a=t.memoizedProps;switch(t.type){case"button":case"input":case"select":case"textarea":a.autoFocus&&n.focus();break;case"img":a.src&&(n.src=a.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(t.memoizedState===null){var c=t.alternate;if(c!==null){var m=c.memoizedState;if(m!==null){var g=m.dehydrated;g!==null&&Rr(g)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;default:throw Error(w(163))}Ie||t.flags&512&&rs(t)}catch(p){le(t,t.return,p)}}if(t===e){N=null;break}if(n=t.sibling,n!==null){n.return=t.return,N=n;break}N=t.return}}function Mu(e){for(;N!==null;){var t=N;if(t===e){N=null;break}var n=t.sibling;if(n!==null){n.return=t.return,N=n;break}N=t.return}}function Du(e){for(;N!==null;){var t=N;try{switch(t.tag){case 0:case 11:case 15:var n=t.return;try{vi(4,t)}catch(a){le(t,n,a)}break;case 1:var r=t.stateNode;if(typeof r.componentDidMount=="function"){var o=t.return;try{r.componentDidMount()}catch(a){le(t,o,a)}}var i=t.return;try{rs(t)}catch(a){le(t,i,a)}break;case 5:var l=t.return;try{rs(t)}catch(a){le(t,l,a)}}}catch(a){le(t,t.return,a)}if(t===e){N=null;break}var s=t.sibling;if(s!==null){s.return=t.return,N=s;break}N=t.return}}var Fg=Math.ceil,oi=Mt.ReactCurrentDispatcher,Bs=Mt.ReactCurrentOwner,tt=Mt.ReactCurrentBatchConfig,U=0,ve=null,ce=null,ke=0,We=0,jn=sn(0),fe=0,Hr=null,wn=0,yi=0,Ws=0,Cr=null,je=null,Vs=0,Jn=1/0,Et=null,ii=!1,ls=null,en=null,zo=!1,Kt=null,li=0,Er=0,ss=null,Oo=-1,Ao=0;function Oe(){return(U&6)!==0?ae():Oo!==-1?Oo:Oo=ae()}function tn(e){return(e.mode&1)===0?1:(U&2)!==0&&ke!==0?ke&-ke:kg.transition!==null?(Ao===0&&(Ao=uc()),Ao):(e=G,e!==0||(e=window.event,e=e===void 0?16:hc(e.type)),e)}function ft(e,t,n,r){if(50<Er)throw Er=0,ss=null,Error(w(185));Br(e,n,r),((U&2)===0||e!==ve)&&(e===ve&&((U&2)===0&&(yi|=n),fe===4&&Gt(e,ke)),Be(e,r),n===1&&U===0&&(t.mode&1)===0&&(Jn=ae()+500,gi&&an()))}function Be(e,t){var n=e.callbackNode;bf(e,t);var r=Bo(e,e===ve?ke:0);if(r===0)n!==null&&Ba(n),e.callbackNode=null,e.callbackPriority=0;else if(t=r&-r,e.callbackPriority!==t){if(n!=null&&Ba(n),t===1)e.tag===0?wg(Ou.bind(null,e)):Dc(Ou.bind(null,e)),hg(function(){(U&6)===0&&an()}),n=null;else{switch(cc(r)){case 1:n=vs;break;case 4:n=sc;break;case 16:n=Ho;break;case 536870912:n=ac;break;default:n=Ho}n=Ld(n,Nd.bind(null,e))}e.callbackPriority=t,e.callbackNode=n}}function Nd(e,t){if(Oo=-1,Ao=0,(U&6)!==0)throw Error(w(327));var n=e.callbackNode;if(Vn()&&e.callbackNode!==n)return null;var r=Bo(e,e===ve?ke:0);if(r===0)return null;if((r&30)!==0||(r&e.expiredLanes)!==0||t)t=si(e,r);else{t=r;var o=U;U|=2;var i=zd();(ve!==e||ke!==t)&&(Et=null,Jn=ae()+500,mn(e,t));do try{Ug();break}catch(s){Pd(e,s)}while(!0);Is(),oi.current=i,U=o,ce!==null?t=0:(ve=null,ke=0,t=fe)}if(t!==0){if(t===2&&(o=Ml(e),o!==0&&(r=o,t=as(e,o))),t===1)throw n=Hr,mn(e,0),Gt(e,r),Be(e,ae()),n;if(t===6)Gt(e,r);else{if(o=e.current.alternate,(r&30)===0&&!jg(o)&&(t=si(e,r),t===2&&(i=Ml(e),i!==0&&(r=i,t=as(e,i))),t===1))throw n=Hr,mn(e,0),Gt(e,r),Be(e,ae()),n;switch(e.finishedWork=o,e.finishedLanes=r,t){case 0:case 1:throw Error(w(345));case 2:dn(e,je,Et);break;case 3:if(Gt(e,r),(r&130023424)===r&&(t=Vs+500-ae(),10<t)){if(Bo(e,0)!==0)break;if(o=e.suspendedLanes,(o&r)!==r){Oe(),e.pingedLanes|=e.suspendedLanes&o;break}e.timeoutHandle=Hl(dn.bind(null,e,je,Et),t);break}dn(e,je,Et);break;case 4:if(Gt(e,r),(r&4194240)===r)break;for(t=e.eventTimes,o=-1;0<r;){var l=31-pt(r);i=1<<l,l=t[l],l>o&&(o=l),r&=~i}if(r=o,r=ae()-r,r=(120>r?120:480>r?480:1080>r?1080:1920>r?1920:3e3>r?3e3:4320>r?4320:1960*Fg(r/1960))-r,10<r){e.timeoutHandle=Hl(dn.bind(null,e,je,Et),r);break}dn(e,je,Et);break;case 5:dn(e,je,Et);break;default:throw Error(w(329))}}}return Be(e,ae()),e.callbackNode===n?Nd.bind(null,e):null}function as(e,t){var n=Cr;return e.current.memoizedState.isDehydrated&&(mn(e,t).flags|=256),e=si(e,t),e!==2&&(t=je,je=n,t!==null&&us(t)),e}function us(e){je===null?je=e:je.push.apply(je,e)}function jg(e){for(var t=e;;){if(t.flags&16384){var n=t.updateQueue;if(n!==null&&(n=n.stores,n!==null))for(var r=0;r<n.length;r++){var o=n[r],i=o.getSnapshot;o=o.value;try{if(!gt(i(),o))return!1}catch{return!1}}}if(n=t.child,t.subtreeFlags&16384&&n!==null)n.return=t,t=n;else{if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return!0;t=t.return}t.sibling.return=t.return,t=t.sibling}}return!0}function Gt(e,t){for(t&=~Ws,t&=~yi,e.suspendedLanes|=t,e.pingedLanes&=~t,e=e.expirationTimes;0<t;){var n=31-pt(t),r=1<<n;e[n]=-1,t&=~r}}function Ou(e){if((U&6)!==0)throw Error(w(327));Vn();var t=Bo(e,0);if((t&1)===0)return Be(e,ae()),null;var n=si(e,t);if(e.tag!==0&&n===2){var r=Ml(e);r!==0&&(t=r,n=as(e,r))}if(n===1)throw n=Hr,mn(e,0),Gt(e,t),Be(e,ae()),n;if(n===6)throw Error(w(345));return e.finishedWork=e.current.alternate,e.finishedLanes=t,dn(e,je,Et),Be(e,ae()),null}function Gs(e,t){var n=U;U|=1;try{return e(t)}finally{U=n,U===0&&(Jn=ae()+500,gi&&an())}}function kn(e){Kt!==null&&Kt.tag===0&&(U&6)===0&&Vn();var t=U;U|=1;var n=tt.transition,r=G;try{if(tt.transition=null,G=1,e)return e()}finally{G=r,tt.transition=n,U=t,(U&6)===0&&an()}}function Qs(){We=jn.current,Z(jn)}function mn(e,t){e.finishedWork=null,e.finishedLanes=0;var n=e.timeoutHandle;if(n!==-1&&(e.timeoutHandle=-1,mg(n)),ce!==null)for(n=ce.return;n!==null;){var r=n;switch(Ps(r),r.tag){case 1:r=r.type.childContextTypes,r!=null&&Ko();break;case 3:Xn(),Z(Ue),Z(Re),Os();break;case 5:Ds(r);break;case 4:Xn();break;case 13:Z(te);break;case 19:Z(te);break;case 10:Rs(r.type._context);break;case 22:case 23:Qs()}n=n.return}if(ve=e,ce=e=nn(e.current,null),ke=We=t,fe=0,Hr=null,Ws=yi=wn=0,je=Cr=null,fn!==null){for(t=0;t<fn.length;t++)if(n=fn[t],r=n.interleaved,r!==null){n.interleaved=null;var o=r.next,i=n.pending;if(i!==null){var l=i.next;i.next=o,r.next=l}n.pending=r}fn=null}return e}function Pd(e,t){do{var n=ce;try{if(Is(),Lo.current=ri,ni){for(var r=ne.memoizedState;r!==null;){var o=r.queue;o!==null&&(o.pending=null),r=r.next}ni=!1}if(xn=0,he=pe=ne=null,Sr=!1,jr=0,Bs.current=null,n===null||n.return===null){fe=1,Hr=t,ce=null;break}e:{var i=e,l=n.return,s=n,a=t;if(t=ke,s.flags|=32768,a!==null&&typeof a=="object"&&typeof a.then=="function"){var c=a,m=s,g=m.tag;if((m.mode&1)===0&&(g===0||g===11||g===15)){var p=m.alternate;p?(m.updateQueue=p.updateQueue,m.memoizedState=p.memoizedState,m.lanes=p.lanes):(m.updateQueue=null,m.memoizedState=null)}var v=bu(l);if(v!==null){v.flags&=-257,Cu(v,l,s,i,t),v.mode&1&&Su(i,c,t),t=v,a=c;var y=t.updateQueue;if(y===null){var h=new Set;h.add(a),t.updateQueue=h}else y.add(a);break e}else{if((t&1)===0){Su(i,c,t),Ks();break e}a=Error(w(426))}}else if(J&&s.mode&1){var I=bu(l);if(I!==null){(I.flags&65536)===0&&(I.flags|=256),Cu(I,l,s,i,t),zs(Zn(a,s));break e}}i=a=Zn(a,s),fe!==4&&(fe=2),Cr===null?Cr=[i]:Cr.push(i),i=l;do{switch(i.tag){case 3:i.flags|=65536,t&=-t,i.lanes|=t;var d=cd(i,a,t);hu(i,d);break e;case 1:s=a;var u=i.type,f=i.stateNode;if((i.flags&128)===0&&(typeof u.getDerivedStateFromError=="function"||f!==null&&typeof f.componentDidCatch=="function"&&(en===null||!en.has(f)))){i.flags|=65536,t&=-t,i.lanes|=t;var x=dd(i,s,t);hu(i,x);break e}}i=i.return}while(i!==null)}Id(n)}catch(S){t=S,ce===n&&n!==null&&(ce=n=n.return);continue}break}while(!0)}function zd(){var e=oi.current;return oi.current=ri,e===null?ri:e}function Ks(){(fe===0||fe===3||fe===2)&&(fe=4),ve===null||(wn&268435455)===0&&(yi&268435455)===0||Gt(ve,ke)}function si(e,t){var n=U;U|=2;var r=zd();(ve!==e||ke!==t)&&(Et=null,mn(e,t));do try{$g();break}catch(o){Pd(e,o)}while(!0);if(Is(),U=n,oi.current=r,ce!==null)throw Error(w(261));return ve=null,ke=0,fe}function $g(){for(;ce!==null;)_d(ce)}function Ug(){for(;ce!==null&&!gf();)_d(ce)}function _d(e){var t=Td(e.alternate,e,We);e.memoizedProps=e.pendingProps,t===null?Id(e):ce=t,Bs.current=null}function Id(e){var t=e;do{var n=t.alternate;if(e=t.return,(t.flags&32768)===0){if(n=Lg(n,t,We),n!==null){ce=n;return}}else{if(n=Mg(n,t),n!==null){n.flags&=32767,ce=n;return}if(e!==null)e.flags|=32768,e.subtreeFlags=0,e.deletions=null;else{fe=6,ce=null;return}}if(t=t.sibling,t!==null){ce=t;return}ce=t=e}while(t!==null);fe===0&&(fe=5)}function dn(e,t,n){var r=G,o=tt.transition;try{tt.transition=null,G=1,Hg(e,t,n,r)}finally{tt.transition=o,G=r}return null}function Hg(e,t,n,r){do Vn();while(Kt!==null);if((U&6)!==0)throw Error(w(327));n=e.finishedWork;var o=e.finishedLanes;if(n===null)return null;if(e.finishedWork=null,e.finishedLanes=0,n===e.current)throw Error(w(177));e.callbackNode=null,e.callbackPriority=0;var i=n.lanes|n.childLanes;if(Cf(e,i),e===ve&&(ce=ve=null,ke=0),(n.subtreeFlags&2064)===0&&(n.flags&2064)===0||zo||(zo=!0,Ld(Ho,function(){return Vn(),null})),i=(n.flags&15990)!==0,(n.subtreeFlags&15990)!==0||i){i=tt.transition,tt.transition=null;var l=G;G=1;var s=U;U|=4,Bs.current=null,Og(e,n),Cd(n,e),cg($l),Wo=!!jl,$l=jl=null,e.current=n,Ag(n,e,o),mf(),U=s,G=l,tt.transition=i}else e.current=n;if(zo&&(zo=!1,Kt=e,li=o),i=e.pendingLanes,i===0&&(en=null),yf(n.stateNode,r),Be(e,ae()),t!==null)for(r=e.onRecoverableError,n=0;n<t.length;n++)o=t[n],r(o.value,{componentStack:o.stack,digest:o.digest});if(ii)throw ii=!1,e=ls,ls=null,e;return(li&1)!==0&&e.tag!==0&&Vn(),i=e.pendingLanes,(i&1)!==0?e===ss?Er++:(Er=0,ss=e):Er=0,an(),null}function Vn(){if(Kt!==null){var e=cc(li),t=tt.transition,n=G;try{if(tt.transition=null,G=16>e?16:e,Kt===null)var r=!1;else{if(e=Kt,Kt=null,li=0,(U&6)!==0)throw Error(w(331));var o=U;for(U|=4,N=e.current;N!==null;){var i=N,l=i.child;if((N.flags&16)!==0){var s=i.deletions;if(s!==null){for(var a=0;a<s.length;a++){var c=s[a];for(N=c;N!==null;){var m=N;switch(m.tag){case 0:case 11:case 15:br(8,m,i)}var g=m.child;if(g!==null)g.return=m,N=g;else for(;N!==null;){m=N;var p=m.sibling,v=m.return;if(kd(m),m===c){N=null;break}if(p!==null){p.return=v,N=p;break}N=v}}}var y=i.alternate;if(y!==null){var h=y.child;if(h!==null){y.child=null;do{var I=h.sibling;h.sibling=null,h=I}while(h!==null)}}N=i}}if((i.subtreeFlags&2064)!==0&&l!==null)l.return=i,N=l;else e:for(;N!==null;){if(i=N,(i.flags&2048)!==0)switch(i.tag){case 0:case 11:case 15:br(9,i,i.return)}var d=i.sibling;if(d!==null){d.return=i.return,N=d;break e}N=i.return}}var u=e.current;for(N=u;N!==null;){l=N;var f=l.child;if((l.subtreeFlags&2064)!==0&&f!==null)f.return=l,N=f;else e:for(l=u;N!==null;){if(s=N,(s.flags&2048)!==0)try{switch(s.tag){case 0:case 11:case 15:vi(9,s)}}catch(S){le(s,s.return,S)}if(s===l){N=null;break e}var x=s.sibling;if(x!==null){x.return=s.return,N=x;break e}N=s.return}}if(U=o,an(),xt&&typeof xt.onPostCommitFiberRoot=="function")try{xt.onPostCommitFiberRoot(ui,e)}catch{}r=!0}return r}finally{G=n,tt.transition=t}}return!1}function Au(e,t,n){t=Zn(n,t),t=cd(e,t,1),e=qt(e,t,1),t=Oe(),e!==null&&(Br(e,1,t),Be(e,t))}function le(e,t,n){if(e.tag===3)Au(e,e,n);else for(;t!==null;){if(t.tag===3){Au(t,e,n);break}else if(t.tag===1){var r=t.stateNode;if(typeof t.type.getDerivedStateFromError=="function"||typeof r.componentDidCatch=="function"&&(en===null||!en.has(r))){e=Zn(n,e),e=dd(t,e,1),t=qt(t,e,1),e=Oe(),t!==null&&(Br(t,1,e),Be(t,e));break}}t=t.return}}function Bg(e,t,n){var r=e.pingCache;r!==null&&r.delete(t),t=Oe(),e.pingedLanes|=e.suspendedLanes&n,ve===e&&(ke&n)===n&&(fe===4||fe===3&&(ke&130023424)===ke&&500>ae()-Vs?mn(e,0):Ws|=n),Be(e,t)}function Rd(e,t){t===0&&((e.mode&1)===0?t=1:(t=go,go<<=1,(go&130023424)===0&&(go=4194304)));var n=Oe();e=Tt(e,t),e!==null&&(Br(e,t,n),Be(e,n))}function Wg(e){var t=e.memoizedState,n=0;t!==null&&(n=t.retryLane),Rd(e,n)}function Vg(e,t){var n=0;switch(e.tag){case 13:var r=e.stateNode,o=e.memoizedState;o!==null&&(n=o.retryLane);break;case 19:r=e.stateNode;break;default:throw Error(w(314))}r!==null&&r.delete(t),Rd(e,n)}var Td;Td=function(e,t,n){if(e!==null)if(e.memoizedProps!==t.pendingProps||Ue.current)$e=!0;else{if((e.lanes&n)===0&&(t.flags&128)===0)return $e=!1,Tg(e,t,n);$e=(e.flags&131072)!==0}else $e=!1,J&&(t.flags&1048576)!==0&&Oc(t,Zo,t.index);switch(t.lanes=0,t.tag){case 2:var r=t.type;Do(e,t),e=t.pendingProps;var o=Qn(t,Re.current);Wn(t,n),o=Fs(null,t,r,e,o,n);var i=js();return t.flags|=1,typeof o=="object"&&o!==null&&typeof o.render=="function"&&o.$$typeof===void 0?(t.tag=1,t.memoizedState=null,t.updateQueue=null,He(r)?(i=!0,Yo(t)):i=!1,t.memoizedState=o.state!==null&&o.state!==void 0?o.state:null,Ls(t),o.updater=hi,t.stateNode=o,o._reactInternals=t,Yl(t,r,e,n),t=Jl(null,t,r,!0,i,n)):(t.tag=0,J&&i&&Ns(t),De(null,t,o,n),t=t.child),t;case 16:r=t.elementType;e:{switch(Do(e,t),e=t.pendingProps,o=r._init,r=o(r._payload),t.type=r,o=t.tag=Qg(r),e=ut(r,e),o){case 0:t=Zl(null,t,r,e,n);break e;case 1:t=Pu(null,t,r,e,n);break e;case 11:t=Eu(null,t,r,e,n);break e;case 14:t=Nu(null,t,r,ut(r.type,e),n);break e}throw Error(w(306,r,""))}return t;case 0:return r=t.type,o=t.pendingProps,o=t.elementType===r?o:ut(r,o),Zl(e,t,r,o,n);case 1:return r=t.type,o=t.pendingProps,o=t.elementType===r?o:ut(r,o),Pu(e,t,r,o,n);case 3:e:{if(md(t),e===null)throw Error(w(387));r=t.pendingProps,i=t.memoizedState,o=i.element,Hc(e,t),ei(t,r,null,n);var l=t.memoizedState;if(r=l.element,i.isDehydrated)if(i={element:r,isDehydrated:!1,cache:l.cache,pendingSuspenseBoundaries:l.pendingSuspenseBoundaries,transitions:l.transitions},t.updateQueue.baseState=i,t.memoizedState=i,t.flags&256){o=Zn(Error(w(423)),t),t=zu(e,t,r,n,o);break e}else if(r!==o){o=Zn(Error(w(424)),t),t=zu(e,t,r,n,o);break e}else for(Ve=Jt(t.stateNode.containerInfo.firstChild),Ge=t,J=!0,dt=null,n=$c(t,null,r,n),t.child=n;n;)n.flags=n.flags&-3|4096,n=n.sibling;else{if(Kn(),r===o){t=Lt(e,t,n);break e}De(e,t,r,n)}t=t.child}return t;case 5:return Bc(t),e===null&&Gl(t),r=t.type,o=t.pendingProps,i=e!==null?e.memoizedProps:null,l=o.children,Ul(r,o)?l=null:i!==null&&Ul(r,i)&&(t.flags|=32),gd(e,t),De(e,t,l,n),t.child;case 6:return e===null&&Gl(t),null;case 13:return hd(e,t,n);case 4:return Ms(t,t.stateNode.containerInfo),r=t.pendingProps,e===null?t.child=Yn(t,null,r,n):De(e,t,r,n),t.child;case 11:return r=t.type,o=t.pendingProps,o=t.elementType===r?o:ut(r,o),Eu(e,t,r,o,n);case 7:return De(e,t,t.pendingProps,n),t.child;case 8:return De(e,t,t.pendingProps.children,n),t.child;case 12:return De(e,t,t.pendingProps.children,n),t.child;case 10:e:{if(r=t.type._context,o=t.pendingProps,i=t.memoizedProps,l=o.value,Y(Jo,r._currentValue),r._currentValue=l,i!==null)if(gt(i.value,l)){if(i.children===o.children&&!Ue.current){t=Lt(e,t,n);break e}}else for(i=t.child,i!==null&&(i.return=t);i!==null;){var s=i.dependencies;if(s!==null){l=i.child;for(var a=s.firstContext;a!==null;){if(a.context===r){if(i.tag===1){a=_t(-1,n&-n),a.tag=2;var c=i.updateQueue;if(c!==null){c=c.shared;var m=c.pending;m===null?a.next=a:(a.next=m.next,m.next=a),c.pending=a}}i.lanes|=n,a=i.alternate,a!==null&&(a.lanes|=n),Ql(i.return,n,t),s.lanes|=n;break}a=a.next}}else if(i.tag===10)l=i.type===t.type?null:i.child;else if(i.tag===18){if(l=i.return,l===null)throw Error(w(341));l.lanes|=n,s=l.alternate,s!==null&&(s.lanes|=n),Ql(l,n,t),l=i.sibling}else l=i.child;if(l!==null)l.return=i;else for(l=i;l!==null;){if(l===t){l=null;break}if(i=l.sibling,i!==null){i.return=l.return,l=i;break}l=l.return}i=l}De(e,t,o.children,n),t=t.child}return t;case 9:return o=t.type,r=t.pendingProps.children,Wn(t,n),o=nt(o),r=r(o),t.flags|=1,De(e,t,r,n),t.child;case 14:return r=t.type,o=ut(r,t.pendingProps),o=ut(r.type,o),Nu(e,t,r,o,n);case 15:return pd(e,t,t.type,t.pendingProps,n);case 17:return r=t.type,o=t.pendingProps,o=t.elementType===r?o:ut(r,o),Do(e,t),t.tag=1,He(r)?(e=!0,Yo(t)):e=!1,Wn(t,n),ud(t,r,o),Yl(t,r,o,n),Jl(null,t,r,!0,e,n);case 19:return vd(e,t,n);case 22:return fd(e,t,n)}throw Error(w(156,t.tag))};function Ld(e,t){return lc(e,t)}function Gg(e,t,n,r){this.tag=e,this.key=n,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.ref=null,this.pendingProps=t,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=r,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function et(e,t,n,r){return new Gg(e,t,n,r)}function Ys(e){return e=e.prototype,!(!e||!e.isReactComponent)}function Qg(e){if(typeof e=="function")return Ys(e)?1:0;if(e!=null){if(e=e.$$typeof,e===gs)return 11;if(e===ms)return 14}return 2}function nn(e,t){var n=e.alternate;return n===null?(n=et(e.tag,t,e.key,e.mode),n.elementType=e.elementType,n.type=e.type,n.stateNode=e.stateNode,n.alternate=e,e.alternate=n):(n.pendingProps=t,n.type=e.type,n.flags=0,n.subtreeFlags=0,n.deletions=null),n.flags=e.flags&14680064,n.childLanes=e.childLanes,n.lanes=e.lanes,n.child=e.child,n.memoizedProps=e.memoizedProps,n.memoizedState=e.memoizedState,n.updateQueue=e.updateQueue,t=e.dependencies,n.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext},n.sibling=e.sibling,n.index=e.index,n.ref=e.ref,n}function Fo(e,t,n,r,o,i){var l=2;if(r=e,typeof e=="function")Ys(e)&&(l=1);else if(typeof e=="string")l=5;else e:switch(e){case _n:return hn(n.children,o,i,t);case fs:l=8,o|=8;break;case xl:return e=et(12,n,t,o|2),e.elementType=xl,e.lanes=i,e;case wl:return e=et(13,n,t,o),e.elementType=wl,e.lanes=i,e;case kl:return e=et(19,n,t,o),e.elementType=kl,e.lanes=i,e;case Bu:return xi(n,o,i,t);default:if(typeof e=="object"&&e!==null)switch(e.$$typeof){case Uu:l=10;break e;case Hu:l=9;break e;case gs:l=11;break e;case ms:l=14;break e;case Bt:l=16,r=null;break e}throw Error(w(130,e==null?e:typeof e,""))}return t=et(l,n,t,o),t.elementType=e,t.type=r,t.lanes=i,t}function hn(e,t,n,r){return e=et(7,e,r,t),e.lanes=n,e}function xi(e,t,n,r){return e=et(22,e,r,t),e.elementType=Bu,e.lanes=n,e.stateNode={isHidden:!1},e}function hl(e,t,n){return e=et(6,e,null,t),e.lanes=n,e}function vl(e,t,n){return t=et(4,e.children!==null?e.children:[],e.key,t),t.lanes=n,t.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},t}function Kg(e,t,n,r,o){this.tag=t,this.containerInfo=e,this.finishedWork=this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.pendingContext=this.context=null,this.callbackPriority=0,this.eventTimes=el(0),this.expirationTimes=el(-1),this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=el(0),this.identifierPrefix=r,this.onRecoverableError=o,this.mutableSourceEagerHydrationData=null}function Xs(e,t,n,r,o,i,l,s,a){return e=new Kg(e,t,n,s,a),t===1?(t=1,i===!0&&(t|=8)):t=0,i=et(3,null,null,t),e.current=i,i.stateNode=e,i.memoizedState={element:r,isDehydrated:n,cache:null,transitions:null,pendingSuspenseBoundaries:null},Ls(i),e}function Yg(e,t,n){var r=3<arguments.length&&arguments[3]!==void 0?arguments[3]:null;return{$$typeof:zn,key:r==null?null:""+r,children:e,containerInfo:t,implementation:n}}function Md(e){if(!e)return on;e=e._reactInternals;e:{if(bn(e)!==e||e.tag!==1)throw Error(w(170));var t=e;do{switch(t.tag){case 3:t=t.stateNode.context;break e;case 1:if(He(t.type)){t=t.stateNode.__reactInternalMemoizedMergedChildContext;break e}}t=t.return}while(t!==null);throw Error(w(171))}if(e.tag===1){var n=e.type;if(He(n))return Mc(e,n,t)}return t}function Dd(e,t,n,r,o,i,l,s,a){return e=Xs(n,r,!0,e,o,i,l,s,a),e.context=Md(null),n=e.current,r=Oe(),o=tn(n),i=_t(r,o),i.callback=t??null,qt(n,i,o),e.current.lanes=o,Br(e,o,r),Be(e,r),e}function wi(e,t,n,r){var o=t.current,i=Oe(),l=tn(o);return n=Md(n),t.context===null?t.context=n:t.pendingContext=n,t=_t(i,l),t.payload={element:e},r=r===void 0?null:r,r!==null&&(t.callback=r),e=qt(o,t,l),e!==null&&(ft(e,o,l,i),To(e,o,l)),l}function ai(e){return e=e.current,e.child?(e.child.tag===5,e.child.stateNode):null}function Fu(e,t){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var n=e.retryLane;e.retryLane=n!==0&&n<t?n:t}}function Zs(e,t){Fu(e,t),(e=e.alternate)&&Fu(e,t)}function Xg(){return null}var Od=typeof reportError=="function"?reportError:function(e){console.error(e)};function Js(e){this._internalRoot=e}ki.prototype.render=Js.prototype.render=function(e){var t=this._internalRoot;if(t===null)throw Error(w(409));wi(e,t,null,null)};ki.prototype.unmount=Js.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var t=e.containerInfo;kn(function(){wi(null,e,null,null)}),t[Rt]=null}};function ki(e){this._internalRoot=e}ki.prototype.unstable_scheduleHydration=function(e){if(e){var t=fc();e={blockedOn:null,target:e,priority:t};for(var n=0;n<Vt.length&&t!==0&&t<Vt[n].priority;n++);Vt.splice(n,0,e),n===0&&mc(e)}};function qs(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}function Si(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11&&(e.nodeType!==8||e.nodeValue!==" react-mount-point-unstable "))}function ju(){}function Zg(e,t,n,r,o){if(o){if(typeof r=="function"){var i=r;r=function(){var c=ai(l);i.call(c)}}var l=Dd(t,r,e,0,null,!1,!1,"",ju);return e._reactRootContainer=l,e[Rt]=l.current,Mr(e.nodeType===8?e.parentNode:e),kn(),l}for(;o=e.lastChild;)e.removeChild(o);if(typeof r=="function"){var s=r;r=function(){var c=ai(a);s.call(c)}}var a=Xs(e,0,!1,null,null,!1,!1,"",ju);return e._reactRootContainer=a,e[Rt]=a.current,Mr(e.nodeType===8?e.parentNode:e),kn(function(){wi(t,a,n,r)}),a}function bi(e,t,n,r,o){var i=n._reactRootContainer;if(i){var l=i;if(typeof o=="function"){var s=o;o=function(){var a=ai(l);s.call(a)}}wi(t,l,e,o)}else l=Zg(n,t,e,o,r);return ai(l)}dc=function(e){switch(e.tag){case 3:var t=e.stateNode;if(t.current.memoizedState.isDehydrated){var n=mr(t.pendingLanes);n!==0&&(ys(t,n|1),Be(t,ae()),(U&6)===0&&(Jn=ae()+500,an()))}break;case 13:kn(function(){var r=Tt(e,1);if(r!==null){var o=Oe();ft(r,e,1,o)}}),Zs(e,1)}};xs=function(e){if(e.tag===13){var t=Tt(e,134217728);if(t!==null){var n=Oe();ft(t,e,134217728,n)}Zs(e,134217728)}};pc=function(e){if(e.tag===13){var t=tn(e),n=Tt(e,t);if(n!==null){var r=Oe();ft(n,e,t,r)}Zs(e,t)}};fc=function(){return G};gc=function(e,t){var n=G;try{return G=e,t()}finally{G=n}};Rl=function(e,t,n){switch(t){case"input":if(Cl(e,n),t=n.name,n.type==="radio"&&t!=null){for(n=e;n.parentNode;)n=n.parentNode;for(n=n.querySelectorAll("input[name="+JSON.stringify(""+t)+'][type="radio"]'),t=0;t<n.length;t++){var r=n[t];if(r!==e&&r.form===e.form){var o=fi(r);if(!o)throw Error(w(90));Vu(r),Cl(r,o)}}}break;case"textarea":Qu(e,n);break;case"select":t=n.value,t!=null&&$n(e,!!n.multiple,t,!1)}};ec=Gs;tc=kn;var Jg={usingClientEntryPoint:!1,Events:[Vr,Ln,fi,Ju,qu,Gs]},dr={findFiberByHostInstance:pn,bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"},qg={bundleType:dr.bundleType,version:dr.version,rendererPackageName:dr.rendererPackageName,rendererConfig:dr.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:Mt.ReactCurrentDispatcher,findHostInstanceByFiber:function(e){return e=oc(e),e===null?null:e.stateNode},findFiberByHostInstance:dr.findFiberByHostInstance||Xg,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:"18.3.1-next-f1338f8080-20240426"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"&&(pr=__REACT_DEVTOOLS_GLOBAL_HOOK__,!pr.isDisabled&&pr.supportsFiber))try{ui=pr.inject(qg),xt=pr}catch{}var pr;Ye.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=Jg;Ye.createPortal=function(e,t){var n=2<arguments.length&&arguments[2]!==void 0?arguments[2]:null;if(!qs(t))throw Error(w(200));return Yg(e,t,null,n)};Ye.createRoot=function(e,t){if(!qs(e))throw Error(w(299));var n=!1,r="",o=Od;return t!=null&&(t.unstable_strictMode===!0&&(n=!0),t.identifierPrefix!==void 0&&(r=t.identifierPrefix),t.onRecoverableError!==void 0&&(o=t.onRecoverableError)),t=Xs(e,1,!1,null,null,n,!1,r,o),e[Rt]=t.current,Mr(e.nodeType===8?e.parentNode:e),new Js(t)};Ye.findDOMNode=function(e){if(e==null)return null;if(e.nodeType===1)return e;var t=e._reactInternals;if(t===void 0)throw typeof e.render=="function"?Error(w(188)):(e=Object.keys(e).join(","),Error(w(268,e)));return e=oc(t),e=e===null?null:e.stateNode,e};Ye.flushSync=function(e){return kn(e)};Ye.hydrate=function(e,t,n){if(!Si(t))throw Error(w(200));return bi(null,e,t,!0,n)};Ye.hydrateRoot=function(e,t,n){if(!qs(e))throw Error(w(405));var r=n!=null&&n.hydratedSources||null,o=!1,i="",l=Od;if(n!=null&&(n.unstable_strictMode===!0&&(o=!0),n.identifierPrefix!==void 0&&(i=n.identifierPrefix),n.onRecoverableError!==void 0&&(l=n.onRecoverableError)),t=Dd(t,null,e,1,n??null,o,!1,i,l),e[Rt]=t.current,Mr(e),r)for(e=0;e<r.length;e++)n=r[e],o=n._getVersion,o=o(n._source),t.mutableSourceEagerHydrationData==null?t.mutableSourceEagerHydrationData=[n,o]:t.mutableSourceEagerHydrationData.push(n,o);return new ki(t)};Ye.render=function(e,t,n){if(!Si(t))throw Error(w(200));return bi(null,e,t,!1,n)};Ye.unmountComponentAtNode=function(e){if(!Si(e))throw Error(w(40));return e._reactRootContainer?(kn(function(){bi(null,null,e,!1,function(){e._reactRootContainer=null,e[Rt]=null})}),!0):!1};Ye.unstable_batchedUpdates=Gs;Ye.unstable_renderSubtreeIntoContainer=function(e,t,n,r){if(!Si(n))throw Error(w(200));if(e==null||e._reactInternals===void 0)throw Error(w(38));return bi(e,t,n,!1,r)};Ye.version="18.3.1-next-f1338f8080-20240426"});var $d=Ct((Am,jd)=>{"use strict";function Fd(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(Fd)}catch(e){console.error(e)}}Fd(),jd.exports=Ad()});var Hd=Ct(ea=>{"use strict";var Ud=$d();ea.createRoot=Ud.createRoot,ea.hydrateRoot=Ud.hydrateRoot;var Fm});var Wd=Ct(Ci=>{"use strict";var em=Ne(),tm=Symbol.for("react.element"),nm=Symbol.for("react.fragment"),rm=Object.prototype.hasOwnProperty,om=em.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner,im={key:!0,ref:!0,__self:!0,__source:!0};function Bd(e,t,n){var r,o={},i=null,l=null;n!==void 0&&(i=""+n),t.key!==void 0&&(i=""+t.key),t.ref!==void 0&&(l=t.ref);for(r in t)rm.call(t,r)&&!im.hasOwnProperty(r)&&(o[r]=t[r]);if(e&&e.defaultProps)for(r in t=e.defaultProps,t)o[r]===void 0&&(o[r]=t[r]);return{$$typeof:tm,type:e,key:i,ref:l,props:o,_owner:om.current}}Ci.Fragment=nm;Ci.jsx=Bd;Ci.jsxs=Bd});var H=Ct((Um,Vd)=>{"use strict";Vd.exports=Wd()});var wp=T(Ne()),kp=T(Hd());var Ei=T(Ne()),Kd=T(H()),Gd=(0,Ei.createContext)(null),Qd=({api:e,children:t})=>(0,Kd.jsx)(Gd.Provider,{value:e,children:t});function ot(){let e=(0,Ei.useContext)(Gd);if(!e)throw new Error("usePluginAPI must be used inside PluginProvider");return e}var B=T(Ne());var Qr=["in-progress","review","blocked","deferred","cancelled"],Cn=[{id:"todo",title:"To Do",state:"open",labels:[],accentColor:"#64748b",bgColor:"rgba(100,116,139,0.1)"},{id:"in-progress",title:"In Progress",state:"open",labels:["in-progress"],accentColor:"#0ea5e9",bgColor:"rgba(14,165,233,0.08)"},{id:"review",title:"In Review",state:"open",labels:["review"],accentColor:"#8b5cf6",bgColor:"rgba(139,92,246,0.08)"},{id:"blocked",title:"Blocked",state:"open",labels:["blocked"],accentColor:"#ef4444",bgColor:"rgba(239,68,68,0.08)"},{id:"done",title:"Done",state:"closed",labels:[],accentColor:"#10b981",bgColor:"rgba(16,185,129,0.08)"}];function lm(e){let t=/^#?([0-9a-f]{6})$/i.exec(e);if(!t||!t[1])return null;let n=parseInt(t[1],16);return{r:n>>16&255,g:n>>8&255,b:n&255}}function Ni(e){let t=new Map;for(let n of e)for(let r of n.labels){let o=r.name.toLowerCase();!t.has(o)&&/^[0-9a-f]{6}$/i.test(r.color)&&t.set(o,r.color)}return Cn.map(n=>{let r=n.labels[0]?.toLowerCase(),o=r?t.get(r):void 0;if(!o)return n;let i=lm(o);return{...n,accentColor:`#${o}`,bgColor:i?`rgba(${i.r},${i.g},${i.b},0.08)`:n.bgColor}})}function Kr(e){if(e.state==="closed")return"done";let t=e.labels.map(n=>n.name);for(let n of Cn)if(n.labels.length>0&&n.labels.some(r=>t.includes(r)))return n.id;return"todo"}function Pi(e,t){let n=Cn.find(l=>l.id===t);if(!n)return null;let r=new Set(Qr.filter(l=>!n.labels.includes(l))),o=e.labels.map(l=>l.name),i=[...new Set([...o.filter(l=>!r.has(l)),...n.labels])];return{state:n.state,labels:i}}var sm=["p0","critical","blocker","urgent","security","vulnerability","crash","data-loss","high-priority","priority:high","priority-high","high"],am=["p1","medium-priority","priority:medium","priority-medium","important","medium"],um=["p2","p3","low-priority","priority:low","priority-low","nice-to-have","minor","low"];function Yr(e){let t=e.map(n=>n.name.toLowerCase());return t.some(n=>sm.some(r=>n===r||n.includes(r)))?"high":t.some(n=>am.some(r=>n===r||n.includes(r)))?"medium":t.some(n=>um.some(r=>n===r||n.includes(r)))?"low":null}var Yd={high:0,medium:1,low:2,unknown:3};function zi(e,t){return t.get(e.number)?.priority??Yr(e.labels)}function Xd(e,t,n,r){return[...e].sort((o,i)=>{let l=0;switch(t){case"number":l=i.number-o.number;break;case"updated":l=Date.parse(i.updated_at)-Date.parse(o.updated_at);break;case"created":l=Date.parse(i.created_at)-Date.parse(o.created_at);break;case"comments":l=i.comments-o.comments;break;case"title":l=o.title.localeCompare(i.title);break;case"priority":{let s=zi(o,r)??"unknown",a=zi(i,r)??"unknown";l=(Yd[s]??3)-(Yd[a]??3);break}}return n==="asc"?-l:l})}var Zr=T(Ne());var na=T(Ne());var Zd=T(Ne());function cm(e){return e.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#x2F;/g,"/")}function Xr(e){let t=[],n=new Set,r=(s,a)=>{if(!s)return;let c=cm(s);n.has(c)||(n.add(c),t.push({alt:a,url:c}))},o=/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,i;for(;(i=o.exec(e))!==null;)r(i[2]??"",i[1]??"");let l=/<img\b([^>]*)>/gi;for(;(i=l.exec(e))!==null;){let s=i[1]??"",a=s.match(/src=["'](https?:\/\/[^"']+)["']/i),c=s.match(/alt=["']([^"']*)["']/i);a?.[1]&&r(a[1],c?.[1]??"")}return t}function ta(e){return e.replace(/!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g,"").replace(/<img\b[^>]*>/gi,"").replace(/\n{3,}/g,`

`).trim()}var be=T(H()),dm={high:"#ef4444",medium:"#f59e0b",low:"#6b7280"};function pm(e){let t=/^#?([0-9a-f]{6})$/i.exec(e);if(!t||!t[1])return null;let n=parseInt(t[1],16);return{r:n>>16&255,g:n>>8&255,b:n&255}}function fm(e){let t=pm(e);return t?.299*t.r+.587*t.g+.114*t.b>140?"#000000":"#ffffff":"#000000"}var Jd=({issue:e,priority:t,priorityReason:n,columnId:r,onClick:o})=>{let i=e.labels.filter(g=>!Qr.includes(g.name)),l=e.body?Xr(e.body):[],s=l.slice(0,3),[a,c]=Zd.default.useState(!1);return(0,be.jsxs)("div",{className:`cgi-card${a?" cgi-card--dragging":""}`,onClick:o,role:"button",tabIndex:0,draggable:!0,onDragStart:g=>{g.dataTransfer.setData("text/plain",JSON.stringify({issueNumber:e.number,fromColumnId:r})),g.dataTransfer.effectAllowed="move",c(!0)},onDragEnd:()=>c(!1),onKeyDown:g=>g.key==="Enter"&&o(),children:[s.length>0&&(0,be.jsxs)("div",{className:"cgi-card-thumbs",children:[s.map((g,p)=>(0,be.jsx)("img",{src:g.url,alt:g.alt||"image",className:"cgi-card-thumb",loading:"lazy"},p)),l.length>3&&(0,be.jsxs)("span",{className:"cgi-card-thumb-more",children:["+",l.length-3]})]}),(0,be.jsxs)("div",{className:"cgi-card-title-row",children:[t&&(0,be.jsx)("span",{className:"cgi-priority-dot",style:{background:dm[t]},title:n?`${t}: ${n}`:t}),(0,be.jsx)("div",{className:"cgi-card-title",children:e.title})]}),(0,be.jsxs)("div",{className:"cgi-card-meta",children:[(0,be.jsxs)("span",{className:"cgi-card-number",children:["#",e.number]}),e.assignees.map(g=>(0,be.jsx)("img",{src:g.avatar_url,alt:g.login,title:g.login,className:"cgi-avatar"},g.login)),e.comments>0&&(0,be.jsxs)("span",{className:"cgi-card-comments",children:[(0,be.jsx)("svg",{width:"11",height:"11",viewBox:"0 0 16 16",fill:"currentColor",children:(0,be.jsx)("path",{d:"M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"})}),e.comments]})]}),i.length>0&&(0,be.jsx)("div",{className:"cgi-card-labels",children:i.map(g=>{let p=`#${g.color}`,v=fm(g.color);return(0,be.jsx)("span",{className:"cgi-label-chip",style:{background:p,color:v},children:g.name},g.id)})})]})};var Te=T(H()),qd=({column:e,issues:t,priorityMap:n,collapsed:r,onToggle:o,onOpenIssue:i,onMoveIssue:l})=>{let[s,a]=na.default.useState(!1),c=na.default.useRef(0),m=h=>{h.preventDefault(),c.current++,a(!0)},g=()=>{c.current--,c.current===0&&a(!1)},p=h=>{h.preventDefault(),h.dataTransfer.dropEffect="move"},v=h=>{h.preventDefault(),c.current=0,a(!1);try{let{issueNumber:I,fromColumnId:d}=JSON.parse(h.dataTransfer.getData("text/plain"));d!==e.id&&l(I,e.id)}catch{}},y=s?{boxShadow:`0 0 0 2px ${e.accentColor}`,background:`${e.bgColor}`}:{};return(0,Te.jsxs)("div",{className:"cgi-column",style:{background:e.bgColor,...y},onDragEnter:m,onDragLeave:g,onDragOver:p,onDrop:v,children:[(0,Te.jsxs)("div",{className:"cgi-column-header",style:{color:e.accentColor,borderBottom:`1px solid ${e.accentColor}30`},onClick:o,title:r?`Expand ${e.title}`:`Collapse ${e.title}`,children:[!r&&(0,Te.jsxs)(Te.Fragment,{children:[(0,Te.jsx)("span",{children:e.title}),(0,Te.jsx)("span",{className:"cgi-column-count",children:t.length}),(0,Te.jsx)("span",{className:"cgi-column-toggle",children:"\u25B2"})]}),r&&(0,Te.jsx)("span",{className:"cgi-column-toggle",style:{margin:"0 auto"},children:"\u25BC"})]}),r?(0,Te.jsx)("div",{className:"cgi-column-body",style:{alignItems:"center",cursor:"pointer"},onClick:o,children:(0,Te.jsxs)("span",{className:"cgi-column-collapsed-label",style:{color:e.accentColor},children:[e.title," (",t.length,")"]})}):(0,Te.jsx)("div",{className:`cgi-column-body${s?" cgi-column-body--drag-over":""}`,children:t.length===0?(0,Te.jsx)("div",{className:`cgi-column-empty${s?" cgi-column-empty--drag-over":""}`,style:{color:e.accentColor},children:s?"\u2193 Drop here":"No issues"}):t.map(h=>(0,Te.jsx)(Jd,{issue:h,priority:n.get(h.number)?.priority??null,priorityReason:n.get(h.number)?.reason,columnId:e.id,onClick:()=>i(h)},h.id))})]})};var Dt=T(H()),gm=640;function mm(){let e=`(max-width: ${gm}px)`,[t,n]=Zr.default.useState(()=>typeof window<"u"&&window.matchMedia(e).matches);return Zr.default.useEffect(()=>{if(typeof window>"u")return;let r=window.matchMedia(e),o=i=>n(i.matches);return n(r.matches),r.addEventListener("change",o),()=>r.removeEventListener("change",o)},[e]),t}var ep=({issues:e,priorityMap:t,collapsedColumns:n,onToggleColumn:r,onMoveIssue:o,onOpenIssue:i})=>{let l=mm(),s=Zr.default.useMemo(()=>Ni(e),[e]),a=Zr.default.useMemo(()=>{let p=new Map;for(let v of s)p.set(v.id,[]);for(let v of e){let y=Kr(v),h=p.get(y);h&&h.push(v)}return p},[e,s]),c=l?s.filter(p=>!n.has(p.id)):s,m=l?s.filter(p=>n.has(p.id)):[],g=c.map(p=>n.has(p.id)?"52px":"minmax(0, 1fr)").join(" ");return(0,Dt.jsxs)("div",{className:"cgi-board-wrap",children:[m.length>0&&(0,Dt.jsx)("div",{className:"cgi-collapsed-bar",children:m.map(p=>(0,Dt.jsxs)("button",{className:"cgi-collapsed-chip",style:{color:p.accentColor,borderColor:`${p.accentColor}55`,background:p.bgColor},onClick:()=>r(p.id),title:`Expand ${p.title}`,children:[(0,Dt.jsx)("span",{className:"cgi-collapsed-chip-dot",style:{background:p.accentColor}}),p.title,(0,Dt.jsx)("span",{className:"cgi-collapsed-chip-count",children:(a.get(p.id)??[]).length})]},p.id))}),(0,Dt.jsx)("div",{className:"cgi-board",style:{gridTemplateColumns:g},children:c.map(p=>(0,Dt.jsx)(qd,{column:p,issues:a.get(p.id)??[],priorityMap:t,collapsed:n.has(p.id),onToggle:()=>r(p.id),onOpenIssue:i,onMoveIssue:o},p.id))})]})};var ye=T(Ne());var _i=T(Ne()),Ot=T(H()),tp=({src:e,alt:t,onClose:n})=>{let[r,o]=(0,_i.useState)(!1);return(0,_i.useEffect)(()=>{o(!1);let i=l=>{l.key==="Escape"&&n()};return window.addEventListener("keydown",i),()=>window.removeEventListener("keydown",i)},[n,e]),(0,Ot.jsxs)("div",{className:"cgi-lightbox-overlay",onClick:n,children:[(0,Ot.jsx)("button",{className:"cgi-lightbox-close",onClick:n,title:"Close (Esc)",children:"\u2715"}),r?(0,Ot.jsxs)("div",{className:"cgi-lightbox-error",onClick:i=>i.stopPropagation(),children:[(0,Ot.jsx)("div",{style:{fontSize:32,marginBottom:8,opacity:.5},children:"\u{1F5BC}"}),(0,Ot.jsx)("div",{style:{fontSize:13,opacity:.8},children:"Image could not be loaded"}),(0,Ot.jsx)("a",{href:e,target:"_blank",rel:"noopener noreferrer",style:{fontSize:12,color:"#60a5fa",marginTop:8,display:"block"},onClick:i=>i.stopPropagation(),children:"Open original URL \u2197"})]}):(0,Ot.jsx)("img",{src:e,alt:t,className:"cgi-lightbox-img",onClick:i=>i.stopPropagation(),onError:()=>o(!0)})]})};var Q=T(H());function it(e,t){let n=[],r=e,o=0,i=[{re:/`([^`]+)`/,render:(l,s)=>(0,Q.jsx)("code",{className:"cgi-md-code",children:l[1]},s)},{re:/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/,render:(l,s)=>(0,Q.jsx)("a",{href:l[2],target:"_blank",rel:"noopener noreferrer",className:"cgi-md-link",children:l[1]},s)},{re:/\*\*([^*]+)\*\*/,render:(l,s)=>(0,Q.jsx)("strong",{children:it(l[1],s)},s)},{re:/__([^_]+)__/,render:(l,s)=>(0,Q.jsx)("strong",{children:it(l[1],s)},s)},{re:/~~([^~]+)~~/,render:(l,s)=>(0,Q.jsx)("del",{children:it(l[1],s)},s)},{re:/\*([^*]+)\*/,render:(l,s)=>(0,Q.jsx)("em",{children:it(l[1],s)},s)},{re:/_([^_]+)_/,render:(l,s)=>(0,Q.jsx)("em",{children:it(l[1],s)},s)}];for(;r.length>0;){let l=null;for(let s of i){let a=s.re.exec(r);a&&(l===null||a.index<l.index)&&(l={index:a.index,match:a,p:s})}if(!l){n.push(r);break}l.index>0&&n.push(r.slice(0,l.index)),n.push(l.p.render(l.match,`${t}-i${o++}`)),r=r.slice(l.index+l.match[0].length)}return n}function np(e){let t=e.trim();return t.startsWith("|")&&(t=t.slice(1)),t.endsWith("|")&&(t=t.slice(0,-1)),t.split("|").map(n=>n.trim())}function rp(e){return/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(e)}var ra=({text:e,className:t})=>{let n=e.replace(/\r\n/g,`
`).split(`
`),r=[],o=0,i=0;for(;i<n.length;){let l=n[i];if(l.trim()===""){i++;continue}if(l.match(/^\s*```(.*)$/)){let m=[];for(i++;i<n.length&&!/^\s*```\s*$/.test(n[i]);)m.push(n[i]),i++;i++,r.push((0,Q.jsx)("pre",{className:"cgi-md-pre",children:(0,Q.jsx)("code",{children:m.join(`
`)})},o++));continue}let a=l.match(/^(#{1,6})\s+(.*)$/);if(a){let m=a[1].length,g=`h${Math.min(m,6)}`;r.push((0,Q.jsx)(g,{className:`cgi-md-h cgi-md-h${m}`,children:it(a[2],o)},o++)),i++;continue}if(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)){r.push((0,Q.jsx)("hr",{className:"cgi-md-hr"},o++)),i++;continue}if(l.includes("|")&&i+1<n.length&&rp(n[i+1])){let m=np(l);i+=2;let g=[];for(;i<n.length&&n[i].includes("|")&&n[i].trim()!=="";)g.push(np(n[i])),i++;r.push((0,Q.jsx)("div",{className:"cgi-md-table-wrap",children:(0,Q.jsxs)("table",{className:"cgi-md-table",children:[(0,Q.jsx)("thead",{children:(0,Q.jsx)("tr",{children:m.map((p,v)=>(0,Q.jsx)("th",{children:it(p,`${o}-th${v}`)},v))})}),(0,Q.jsx)("tbody",{children:g.map((p,v)=>(0,Q.jsx)("tr",{children:p.map((y,h)=>(0,Q.jsx)("td",{children:it(y,`${o}-td${v}-${h}`)},h))},v))})]})},o++));continue}if(/^\s*>\s?/.test(l)){let m=[];for(;i<n.length&&/^\s*>\s?/.test(n[i]);)m.push(n[i].replace(/^\s*>\s?/,"")),i++;r.push((0,Q.jsx)("blockquote",{className:"cgi-md-quote",children:it(m.join(" "),o)},o++));continue}if(/^\s*\d+\.\s+/.test(l)){let m=[],g=0;for(;i<n.length&&/^\s*\d+\.\s+/.test(n[i]);){let p=n[i].replace(/^\s*\d+\.\s+/,"");m.push((0,Q.jsx)("li",{children:it(p,`${o}-ol${g}`)},g++)),i++}r.push((0,Q.jsx)("ol",{className:"cgi-md-ol",children:m},o++));continue}if(/^\s*[-*+]\s+/.test(l)){let m=[],g=0;for(;i<n.length&&/^\s*[-*+]\s+/.test(n[i]);){let p=n[i].replace(/^\s*[-*+]\s+/,"");m.push((0,Q.jsx)("li",{children:it(p,`${o}-ul${g}`)},g++)),i++}r.push((0,Q.jsx)("ul",{className:"cgi-md-ul",children:m},o++));continue}let c=[];for(;i<n.length&&n[i].trim()!==""&&!/^\s*```/.test(n[i])&&!/^(#{1,6})\s+/.test(n[i])&&!/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(n[i])&&!/^\s*>\s?/.test(n[i])&&!/^\s*\d+\.\s+/.test(n[i])&&!/^\s*[-*+]\s+/.test(n[i])&&!(n[i].includes("|")&&i+1<n.length&&rp(n[i+1]));)c.push(n[i]),i++;c.length>0&&r.push((0,Q.jsx)("p",{className:"cgi-md-p",children:it(c.join(`
`),o).flatMap((m,g,p)=>typeof m=="string"?m.split(`
`).flatMap((v,y,h)=>y<h.length-1?[v,(0,Q.jsx)("br",{},`br-${g}-${y}`)]:[v]):[m])},o++))}return(0,Q.jsx)("div",{className:`cgi-md${t?" "+t:""}`,children:r})};var _=T(H()),hm=400,vm=300,ip="cgi-modal-size";function Ii(e,t){return{width:Math.min(Math.max(e,hm),window.innerWidth-32),height:Math.min(Math.max(t,vm),window.innerHeight-80)}}function ym(){try{let e=localStorage.getItem(ip);if(e){let{width:t,height:n}=JSON.parse(e);return Ii(Number(t),Number(n))}}catch{}return Ii(680,Math.round(window.innerHeight*.82))}function op(e){try{return new Date(e).toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"})}catch{return e}}var lp=({issue:e,projectPath:t,columns:n=Cn,onClose:r,onIssueUpdated:o})=>{let i=ot(),[l,s]=(0,ye.useState)([]),[a,c]=(0,ye.useState)(!0),[m,g]=(0,ye.useState)(""),[p,v]=(0,ye.useState)(!1),[y,h]=(0,ye.useState)(null),[I,d]=(0,ye.useState)(null),[u,f]=(0,ye.useState)(e),[x,S]=(0,ye.useState)(null),[k,C]=(0,ye.useState)(ym),b=Kr(u),V=(0,ye.useCallback)(async()=>{c(!0);try{let A=await i.rpc("GET",`/issues/${u.number}/comments?path=${encodeURIComponent(t)}`);s(A.comments??[])}catch{}finally{c(!1)}},[i,u.number,t]);(0,ye.useEffect)(()=>{V()},[V]),(0,ye.useEffect)(()=>{let P=A=>{A.key==="Escape"&&r()};return window.addEventListener("keydown",P),()=>window.removeEventListener("keydown",P)},[r]),(0,ye.useEffect)(()=>{let P=()=>C(A=>Ii(A.width,A.height));return window.addEventListener("resize",P),()=>window.removeEventListener("resize",P)},[]),(0,ye.useEffect)(()=>{localStorage.setItem(ip,JSON.stringify(k))},[k]);let M=(0,ye.useCallback)((P,A)=>{P.preventDefault(),P.stopPropagation();let ge=P.clientX,E=P.clientY,ee=k.width,D=k.height,de=A==="e"?"ew-resize":A==="s"?"ns-resize":"nwse-resize";document.body.style.userSelect="none",document.body.style.cursor=de;let oe=Le=>{let ue=A!=="s"?ee+(Le.clientX-ge):ee,jt=A!=="e"?D+(Le.clientY-E):D;C(Ii(ue,jt))},me=()=>{document.body.style.userSelect="",document.body.style.cursor="",window.removeEventListener("mousemove",oe),window.removeEventListener("mouseup",me)};window.addEventListener("mousemove",oe),window.addEventListener("mouseup",me)},[k.width,k.height]),Ce=async P=>{if(!(P===b||y)){h(P),d(null);try{let A=Pi(u,P);if(!A)return;let E=await i.rpc("PATCH",`/issues/${u.number}?path=${encodeURIComponent(t)}`,A);E.ok&&E.issue&&(f(E.issue),o(E.issue))}catch(A){d(A instanceof Error?A.message:"Failed to move issue")}finally{h(null)}}},St=async P=>{if(P.preventDefault(),!(!m.trim()||p)){v(!0),d(null);try{await i.rpc("POST",`/issues/${u.number}/comments?path=${encodeURIComponent(t)}`,{body:m.trim()}),g(""),await V()}catch(A){d(A instanceof Error?A.message:"Failed to post comment")}finally{v(!1)}}};return(0,_.jsxs)(_.Fragment,{children:[x&&(0,_.jsx)(tp,{src:x.src,alt:x.alt,onClose:()=>S(null)}),(0,_.jsx)("div",{className:"cgi-modal-overlay",onClick:P=>{P.target===P.currentTarget&&r()},children:(0,_.jsxs)("div",{className:"cgi-modal",style:{width:k.width,maxHeight:k.height},onClick:P=>P.stopPropagation(),children:[(0,_.jsxs)("div",{className:"cgi-modal-header",children:[(0,_.jsxs)("div",{style:{flex:1},children:[(0,_.jsx)("div",{className:"cgi-modal-title",children:u.title}),(0,_.jsxs)("div",{className:"cgi-modal-subtitle",children:["#",u.number," \xB7 opened by ",u.user.login," on ",op(u.created_at),u.state==="closed"&&(0,_.jsx)("span",{style:{marginLeft:8,color:"#10b981",fontWeight:600},children:"\u25CF Closed"})]})]}),(0,_.jsxs)("a",{href:u.html_url,target:"_blank",rel:"noopener noreferrer",className:"cgi-btn",title:"Open on GitHub",style:{textDecoration:"none",flexShrink:0},children:[(0,_.jsx)("svg",{width:"13",height:"13",viewBox:"0 0 16 16",fill:"currentColor",children:(0,_.jsx)("path",{d:"M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"})}),"GitHub"]}),(0,_.jsx)("button",{className:"cgi-modal-close",onClick:r,title:"Close",children:"\u2715"})]}),(0,_.jsxs)("div",{className:"cgi-modal-body",children:[u.labels.length>0&&(0,_.jsxs)("div",{children:[(0,_.jsx)("div",{className:"cgi-modal-section-label",children:"Labels"}),(0,_.jsx)("div",{className:"cgi-card-labels",children:u.labels.map(P=>(0,_.jsx)("span",{className:"cgi-label-chip",style:{background:`#${P.color}`,color:parseInt(P.color,16)>8947848?"#000":"#fff",fontSize:12,padding:"2px 8px"},children:P.name},P.id))})]}),u.body&&(()=>{let P=Xr(u.body),A=ta(u.body);return(0,_.jsxs)("div",{children:[(0,_.jsx)("div",{className:"cgi-modal-section-label",children:"Description"}),P.length>0&&(0,_.jsx)("div",{className:"cgi-img-grid",children:P.map((ge,E)=>(0,_.jsx)("button",{className:"cgi-img-thumb-btn",onClick:()=>S({src:ge.url,alt:ge.alt}),title:"Click to enlarge",children:(0,_.jsx)("img",{src:ge.url,alt:ge.alt||"image",className:"cgi-img-thumb",loading:"lazy"})},E))}),A&&(0,_.jsx)(ra,{text:A,className:"cgi-issue-body"})]})})(),(0,_.jsxs)("div",{children:[(0,_.jsx)("div",{className:"cgi-modal-section-label",children:"Move to column"}),(0,_.jsx)("div",{className:"cgi-column-selector",children:n.map(P=>{let A=P.id===Kr(u),ge=A?{background:P.accentColor,borderColor:P.accentColor,color:"#fff"}:{borderColor:`${P.accentColor}80`,color:P.accentColor};return(0,_.jsx)("button",{className:`cgi-column-btn${A?" cgi-column-btn-active":""}`,style:ge,onClick:()=>Ce(P.id),disabled:A||y!==null,children:y===P.id?"...":P.title},P.id)})})]}),I&&(0,_.jsx)("div",{className:"cgi-error-text",children:I}),(0,_.jsxs)("div",{children:[(0,_.jsxs)("div",{className:"cgi-modal-section-label",children:["Comments ",!a&&`(${l.length})`]}),a?(0,_.jsx)("div",{style:{color:"var(--cgi-text-muted)",fontSize:12},children:"Loading comments..."}):l.length>0?(0,_.jsx)("div",{className:"cgi-comments-list",children:l.map(P=>{let A=Xr(P.body),ge=ta(P.body);return(0,_.jsxs)("div",{className:"cgi-comment",children:[(0,_.jsxs)("div",{className:"cgi-comment-header",children:[(0,_.jsx)("img",{src:P.user.avatar_url,alt:P.user.login,className:"cgi-avatar"}),(0,_.jsx)("span",{className:"cgi-comment-author",children:P.user.login}),(0,_.jsx)("span",{children:"\xB7"}),(0,_.jsx)("span",{children:op(P.created_at)})]}),A.length>0&&(0,_.jsx)("div",{className:"cgi-img-grid",style:{marginBottom:ge?8:0},children:A.map((E,ee)=>(0,_.jsx)("button",{className:"cgi-img-thumb-btn",onClick:()=>S({src:E.url,alt:E.alt}),title:"Click to enlarge",children:(0,_.jsx)("img",{src:E.url,alt:E.alt||"image",className:"cgi-img-thumb",loading:"lazy"})},ee))}),ge&&(0,_.jsx)(ra,{text:ge,className:"cgi-comment-body"})]},P.id)})}):(0,_.jsx)("div",{style:{color:"var(--cgi-text-muted)",fontSize:12},children:"No comments yet."})]}),(0,_.jsxs)("div",{children:[(0,_.jsx)("div",{className:"cgi-modal-section-label",children:"Add comment"}),(0,_.jsxs)("form",{className:"cgi-comment-form",onSubmit:St,children:[(0,_.jsx)("textarea",{className:"cgi-textarea",placeholder:"Write a comment...",value:m,onChange:P=>g(P.target.value),disabled:p}),(0,_.jsx)("div",{style:{display:"flex",justifyContent:"flex-end"},children:(0,_.jsx)("button",{type:"submit",className:"cgi-btn cgi-btn-primary",disabled:!m.trim()||p,children:p?"Posting...":"Post comment"})})]})]})]}),(0,_.jsx)("div",{className:"cgi-resize-e",onMouseDown:P=>M(P,"e")}),(0,_.jsx)("div",{className:"cgi-resize-s",onMouseDown:P=>M(P,"s")}),(0,_.jsx)("div",{className:"cgi-resize-se",onMouseDown:P=>M(P,"se")})]})})]})};var At=T(Ne());var se=T(H()),sp=({projectPath:e,onClose:t,onCreated:n})=>{let r=ot(),[o,i]=(0,At.useState)(""),[l,s]=(0,At.useState)(""),[a,c]=(0,At.useState)(!1),[m,g]=(0,At.useState)(null),p=(0,At.useRef)(null);(0,At.useEffect)(()=>{p.current?.focus();let h=I=>{I.key==="Escape"&&t()};return window.addEventListener("keydown",h),()=>window.removeEventListener("keydown",h)},[t]);let v=async h=>{if(h.preventDefault(),!(!o.trim()||a)){c(!0),g(null);try{let I=await r.rpc("POST",`/issues?path=${encodeURIComponent(e)}`,{title:o.trim(),body:l.trim()||void 0});I.ok&&I.issue&&n(I.issue)}catch(I){g(I instanceof Error?I.message:"Failed to create issue"),c(!1)}}},y={width:"100%",padding:"8px 10px",borderRadius:6,border:"1px solid var(--cgi-border)",background:"var(--cgi-input-bg)",color:"var(--cgi-text)",fontSize:13,outline:"none",boxSizing:"border-box",fontFamily:"inherit",transition:"border-color 0.15s"};return(0,se.jsx)("div",{style:{position:"fixed",inset:0,zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.55)"},onClick:h=>{h.target===h.currentTarget&&t()},children:(0,se.jsxs)("div",{style:{background:"var(--cgi-modal-bg)",border:"1px solid var(--cgi-border)",borderRadius:12,padding:24,width:500,maxWidth:"92vw",boxShadow:"0 20px 60px rgba(0,0,0,0.4)",display:"flex",flexDirection:"column",gap:16},children:[(0,se.jsxs)("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between"},children:[(0,se.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:8,fontWeight:600,fontSize:15},children:[(0,se.jsx)("svg",{width:"16",height:"16",viewBox:"0 0 16 16",fill:"currentColor",children:(0,se.jsx)("path",{d:"M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"})}),"New Issue"]}),(0,se.jsx)("button",{onClick:t,style:{background:"none",border:"none",cursor:"pointer",color:"var(--cgi-text)",opacity:.5,fontSize:20,lineHeight:1,padding:"2px 4px"},children:"\xD7"})]}),(0,se.jsxs)("form",{onSubmit:v,style:{display:"flex",flexDirection:"column",gap:14},children:[(0,se.jsxs)("div",{children:[(0,se.jsxs)("label",{style:{display:"block",fontSize:11,fontWeight:600,opacity:.65,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"},children:["Title ",(0,se.jsx)("span",{style:{color:"#ef4444"},children:"*"})]}),(0,se.jsx)("input",{ref:p,type:"text",value:o,onChange:h=>i(h.target.value),placeholder:"Short, descriptive title\u2026",style:y,autoComplete:"off",required:!0})]}),(0,se.jsxs)("div",{children:[(0,se.jsxs)("label",{style:{display:"block",fontSize:11,fontWeight:600,opacity:.65,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"},children:["Description ",(0,se.jsx)("span",{style:{opacity:.5,fontWeight:400,textTransform:"none"},children:"(optional)"})]}),(0,se.jsx)("textarea",{value:l,onChange:h=>s(h.target.value),placeholder:"Describe the issue, steps to reproduce, expected vs actual behavior\u2026",style:{...y,minHeight:100,resize:"vertical"}})]}),m&&(0,se.jsx)("div",{style:{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:6,padding:"8px 12px",fontSize:12,color:"#ef4444"},children:m}),(0,se.jsxs)("div",{style:{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:2},children:[(0,se.jsx)("button",{type:"button",onClick:t,className:"cgi-btn",style:{opacity:.7},children:"Cancel"}),(0,se.jsx)("button",{type:"submit",disabled:!o.trim()||a,className:"cgi-btn",style:{background:"var(--cgi-accent)",color:"#fff",border:"none",fontWeight:600},children:a?"Creating\u2026":"Create issue"})]})]})]})})};var Ft=T(Ne()),$=T(H());function xm(e){return`You are a software project manager. Analyze these GitHub issues and assign each a priority level.

Issues:
${e.filter(r=>r.state!=="closed").slice(0,50).map(r=>`#${r.number}: ${r.title}
Labels: ${r.labels.map(o=>o.name).join(", ")||"none"}
Comments: ${r.comments}
Created: ${r.created_at.split("T")[0]}
Description: ${(r.body??"").slice(0,300)}`).join(`

---

`)}

Prioritization criteria:
- high: security vulnerabilities, crashes, data loss, critical bugs blocking users
- medium: regular bugs affecting users, important features, performance problems
- low: minor issues, nice-to-have features, documentation, minor enhancements

Return ONLY valid JSON, no explanation or markdown:
{"priorities":[{"number":<issue_number>,"priority":"high"|"medium"|"low","reason":"<one brief sentence>"}]}`}function wm(e){try{let t=e.match(/\{[\s\S]*\}/);if(!t)return null;let r=(JSON.parse(t[0]).priorities??[]).filter(o=>o.number&&["high","medium","low"].includes(o.priority)).map(o=>({number:o.number,priority:o.priority,score:o.priority==="high"?80:o.priority==="medium"?50:20,reason:o.reason??""}));return r.length>0?r:null}catch{return null}}var ap=({issues:e,onApply:t,onClose:n})=>{let[r,o]=(0,Ft.useState)("prompt"),[i,l]=(0,Ft.useState)(""),[s,a]=(0,Ft.useState)(null),[c,m]=(0,Ft.useState)(!1),g=xm(e),p=(0,Ft.useRef)(null);(0,Ft.useEffect)(()=>{let h=I=>{I.key==="Escape"&&n()};return window.addEventListener("keydown",h),()=>window.removeEventListener("keydown",h)},[n]);let v=()=>{navigator.clipboard.writeText(g).then(()=>{m(!0),setTimeout(()=>m(!1),2e3)})},y=()=>{a(null);let h=wm(i);if(!h){a("Could not parse JSON. Make sure you pasted the full response from Claude.");return}t(h)};return(0,$.jsx)("div",{style:{position:"fixed",inset:0,zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",padding:16},onClick:h=>{h.target===h.currentTarget&&n()},children:(0,$.jsxs)("div",{style:{background:"var(--cgi-modal-bg)",border:"1px solid var(--cgi-border)",borderRadius:12,padding:24,width:580,maxWidth:"96vw",maxHeight:"85vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.45)",display:"flex",flexDirection:"column",gap:16},children:[(0,$.jsxs)("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between"},children:[(0,$.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:8,fontWeight:600,fontSize:15},children:[(0,$.jsx)("svg",{width:"16",height:"16",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",children:(0,$.jsx)("path",{d:"M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"})}),"AI Prioritize \u2014 Claude Subscription"]}),(0,$.jsx)("button",{onClick:n,style:{background:"none",border:"none",cursor:"pointer",color:"var(--cgi-text)",opacity:.5,fontSize:20,lineHeight:1,padding:"2px 4px"},children:"\xD7"})]}),(0,$.jsx)("div",{style:{display:"flex",gap:0,borderRadius:8,overflow:"hidden",border:"1px solid var(--cgi-border)"},children:["prompt","paste"].map((h,I)=>(0,$.jsxs)("button",{onClick:()=>o(h),style:{flex:1,padding:"8px 0",border:"none",fontSize:12,fontWeight:600,background:r===h?"var(--cgi-accent)":"var(--cgi-btn-bg)",color:r===h?"#fff":"var(--cgi-text)",cursor:"pointer",borderRight:I===0?"1px solid var(--cgi-border)":"none"},children:[I+1,". ",h==="prompt"?"Copy Prompt":"Paste Response"]},h))}),r==="prompt"&&(0,$.jsxs)($.Fragment,{children:[(0,$.jsxs)("div",{style:{fontSize:13,opacity:.75,lineHeight:1.5},children:["Copy the prompt below and paste it into ",(0,$.jsx)("strong",{children:"Claude.ai"})," or any Claude chat window. Then come back and click ",(0,$.jsx)("em",{children:"Paste Response"}),"."]}),(0,$.jsx)("div",{style:{position:"relative"},children:(0,$.jsx)("textarea",{ref:p,readOnly:!0,value:g,style:{width:"100%",minHeight:240,padding:"10px 12px",boxSizing:"border-box",background:"var(--cgi-code-bg)",border:"1px solid var(--cgi-border)",borderRadius:8,color:"var(--cgi-text)",fontSize:11,fontFamily:"monospace",lineHeight:1.5,resize:"vertical",outline:"none"},onClick:()=>p.current?.select()})}),(0,$.jsxs)("div",{style:{display:"flex",gap:10,justifyContent:"flex-end"},children:[(0,$.jsx)("button",{onClick:n,className:"cgi-btn",style:{opacity:.7},children:"Cancel"}),(0,$.jsx)("button",{onClick:v,className:"cgi-btn",style:{background:c?"#22c55e":"var(--cgi-accent)",color:"#fff",border:"none",fontWeight:600,minWidth:120},children:c?"\u2713 Copied!":"\u2398 Copy Prompt"}),(0,$.jsx)("button",{onClick:()=>o("paste"),className:"cgi-btn",style:{fontWeight:600},children:"Next \u2192"})]})]}),r==="paste"&&(0,$.jsxs)($.Fragment,{children:[(0,$.jsxs)("div",{style:{fontSize:13,opacity:.75,lineHeight:1.5},children:["Paste Claude's JSON response below. It should start with ",(0,$.jsx)("code",{style:{background:"var(--cgi-code-bg)",padding:"1px 5px",borderRadius:4},children:'{"priorities":['})]}),(0,$.jsx)("textarea",{value:i,onChange:h=>{l(h.target.value),a(null)},placeholder:`Paste Claude's response here...

Expected format:
{"priorities":[{"number":1,"priority":"high","reason":"..."},...]}`,style:{width:"100%",minHeight:200,padding:"10px 12px",boxSizing:"border-box",background:"var(--cgi-input-bg)",border:`1px solid ${s?"#ef4444":"var(--cgi-border)"}`,borderRadius:8,color:"var(--cgi-text)",fontSize:12,fontFamily:"monospace",lineHeight:1.5,resize:"vertical",outline:"none"}}),s&&(0,$.jsx)("div",{style:{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:6,padding:"8px 12px",fontSize:12,color:"#ef4444"},children:s}),(0,$.jsxs)("div",{style:{display:"flex",gap:10,justifyContent:"space-between"},children:[(0,$.jsx)("button",{onClick:()=>o("prompt"),className:"cgi-btn",style:{opacity:.7},children:"\u2190 Back"}),(0,$.jsxs)("div",{style:{display:"flex",gap:8},children:[(0,$.jsx)("button",{onClick:n,className:"cgi-btn",style:{opacity:.7},children:"Cancel"}),(0,$.jsx)("button",{onClick:y,disabled:!i.trim(),className:"cgi-btn",style:{background:"var(--cgi-accent)",color:"#fff",border:"none",fontWeight:600},children:"Apply Priorities"})]})]})]})]})})};var Fe=T(H()),up=({onOpenSettings:e})=>(0,Fe.jsxs)("div",{className:"cgi-config-banner",children:[(0,Fe.jsx)("div",{className:"cgi-config-banner-icon",children:(0,Fe.jsx)("svg",{width:"32",height:"32",viewBox:"0 0 16 16",fill:"currentColor",style:{opacity:.4},children:(0,Fe.jsx)("path",{d:"M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"})})}),(0,Fe.jsx)("h2",{children:"GitHub Issues Board"}),(0,Fe.jsx)("p",{style:{opacity:.65},children:"Connect this project to a GitHub repository to start managing issues as a kanban board."}),(0,Fe.jsx)("button",{className:"cgi-btn",onClick:e,style:{background:"var(--cgi-accent)",color:"#fff",border:"none",fontWeight:600,padding:"9px 20px",fontSize:13},children:"\u2699 Configure GitHub Connection"}),(0,Fe.jsxs)("p",{style:{fontSize:11,opacity:.45,marginTop:8},children:["You'll need a GitHub personal access token with ",(0,Fe.jsx)("code",{style:{background:"rgba(0,0,0,0.1)",padding:"1px 4px",borderRadius:3},children:"repo"})," scope.",(0,Fe.jsx)("br",{}),"Settings are saved to ",(0,Fe.jsx)("code",{style:{background:"rgba(0,0,0,0.1)",padding:"1px 4px",borderRadius:3},children:".GitHubBoard/github-sync.json"})," in your project."]}),(0,Fe.jsxs)("p",{style:{fontSize:11,opacity:.45},children:["The ",(0,Fe.jsx)("strong",{children:"/github-task"})," CLI skill is automatically installed when this plugin loads."]})]});var kt=T(Ne());var L=T(H()),cp=({projectPath:e,onClose:t,onSaved:n,onManualPrioritize:r})=>{let o=ot(),[i,l]=(0,kt.useState)({token:"",owner:"",repo:"",anthropicKey:""}),[s,a]=(0,kt.useState)(!1),[c,m]=(0,kt.useState)(!0),[g,p]=(0,kt.useState)(!1),[v,y]=(0,kt.useState)(null),[h,I]=(0,kt.useState)(!1),[d,u]=(0,kt.useState)(!1);(0,kt.useEffect)(()=>{let k=!1;return m(!0),o.rpc("GET",`/config?path=${encodeURIComponent(e)}`).then(C=>{if(k)return;let b=C;b.configured&&l(V=>({...V,owner:b.owner??"",repo:b.repo??""}))}).catch(()=>{}).finally(()=>{k||m(!1)}),()=>{k=!0}},[o,e]);let f=async()=>{if(y(null),!i.owner.trim()||!i.repo.trim()){y("Owner and repository name are required.");return}if(!i.token.trim()){y("GitHub token is required. You can find it at github.com \u2192 Settings \u2192 Developer settings \u2192 Personal access tokens.");return}p(!0);try{await o.rpc("PUT",`/config?path=${encodeURIComponent(e)}`,{token:i.token.trim(),owner:i.owner.trim(),repo:i.repo.trim(),enabled:!0,anthropicKey:i.anthropicKey.trim()||void 0}),I(!0),setTimeout(()=>{n(),t()},600)}catch(k){y(k instanceof Error?k.message:"Failed to save configuration.")}finally{p(!1)}},x={width:"100%",padding:"8px 10px",borderRadius:6,border:"1px solid var(--cgi-border)",background:"var(--cgi-input-bg)",color:"var(--cgi-text)",fontSize:13,outline:"none",boxSizing:"border-box"},S={display:"block",fontSize:11,fontWeight:600,opacity:.65,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"};return(0,L.jsx)("div",{style:{position:"fixed",inset:0,zIndex:1e3,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.55)"},onClick:k=>{k.target===k.currentTarget&&t()},children:(0,L.jsxs)("div",{style:{background:"var(--cgi-surface)",borderRadius:10,padding:24,width:420,maxWidth:"90vw",boxShadow:"0 20px 60px rgba(0,0,0,0.4)",display:"flex",flexDirection:"column",gap:18},children:[(0,L.jsxs)("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between"},children:[(0,L.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:8,fontWeight:600,fontSize:15},children:[(0,L.jsx)("svg",{width:"16",height:"16",viewBox:"0 0 16 16",fill:"currentColor",children:(0,L.jsx)("path",{d:"M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"})}),"GitHub Issues Board \u2014 Settings"]}),(0,L.jsx)("button",{onClick:t,style:{background:"none",border:"none",cursor:"pointer",color:"var(--cgi-text)",opacity:.5,fontSize:18,lineHeight:1,padding:"2px 6px"},children:"\xD7"})]}),c?(0,L.jsx)("div",{style:{textAlign:"center",padding:"20px 0",opacity:.5},children:"Loading current settings\u2026"}):(0,L.jsxs)(L.Fragment,{children:[(0,L.jsxs)("div",{children:[(0,L.jsx)("label",{style:S,children:"GitHub Personal Access Token"}),(0,L.jsxs)("div",{style:{position:"relative"},children:[(0,L.jsx)("input",{type:d?"text":"password",value:i.token,onChange:k=>l(C=>({...C,token:k.target.value})),placeholder:"ghp_xxxxxxxxxxxxxxxxxxxx",style:{...x,paddingRight:38},autoComplete:"off"}),(0,L.jsx)("button",{onClick:()=>u(k=>!k),style:{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"var(--cgi-text)",opacity:.45,fontSize:12},title:d?"Hide token":"Show token",children:d?"hide":"show"})]}),(0,L.jsxs)("div",{style:{fontSize:11,opacity:.5,marginTop:4},children:["Generate at github.com \u2192 Settings \u2192 Developer settings \u2192 Personal access tokens. Requires ",(0,L.jsx)("code",{children:"repo"})," scope."]})]}),(0,L.jsxs)("div",{children:[(0,L.jsx)("label",{style:S,children:"Repository Owner (username or org)"}),(0,L.jsx)("input",{type:"text",value:i.owner,onChange:k=>l(C=>({...C,owner:k.target.value})),placeholder:"your-github-username",style:x,autoComplete:"off"})]}),(0,L.jsxs)("div",{children:[(0,L.jsx)("label",{style:S,children:"Repository Name"}),(0,L.jsx)("input",{type:"text",value:i.repo,onChange:k=>l(C=>({...C,repo:k.target.value})),placeholder:"your-repository-name",style:x,autoComplete:"off"})]}),(0,L.jsxs)("div",{children:[(0,L.jsxs)("label",{style:S,children:["Anthropic API Key ",(0,L.jsx)("span",{style:{opacity:.5,fontWeight:400,textTransform:"none",fontSize:11},children:"(optional \u2014 enables real AI prioritization)"})]}),(0,L.jsxs)("div",{style:{position:"relative"},children:[(0,L.jsx)("input",{type:s?"text":"password",value:i.anthropicKey,onChange:k=>l(C=>({...C,anthropicKey:k.target.value})),placeholder:"sk-ant-api03-\u2026",style:{...x,paddingRight:38},autoComplete:"off"}),(0,L.jsx)("button",{onClick:()=>a(k=>!k),style:{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"var(--cgi-text)",opacity:.45,fontSize:12},title:s?"Hide key":"Show key",children:s?"hide":"show"})]}),(0,L.jsxs)("div",{style:{fontSize:11,opacity:.5,marginTop:4,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8},children:[(0,L.jsx)("span",{children:"Without a key, AI Prioritize uses smart heuristics. With a key, it uses Claude Haiku for deeper AI analysis."}),r&&(0,L.jsx)("button",{onClick:r,style:{background:"none",border:"none",cursor:"pointer",color:"var(--cgi-accent)",fontSize:11,fontWeight:600,padding:"2px 6px",borderRadius:4,whiteSpace:"nowrap",flexShrink:0},title:"Use Claude.ai subscription: generate a prompt, paste back the response",children:"Use claude.ai \u2192"})]})]}),v&&(0,L.jsx)("div",{style:{background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:6,padding:"8px 12px",fontSize:12,color:"#ef4444"},children:v}),(0,L.jsxs)("div",{style:{borderTop:"1px solid var(--cgi-border)",paddingTop:14,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10},children:[(0,L.jsxs)("div",{style:{fontSize:12,opacity:.6},children:["Use ",(0,L.jsx)("code",{style:{background:"var(--cgi-code-bg)",padding:"1px 5px",borderRadius:4},children:"/github-task"})," skill in Claude chat to manage issues via AI"]}),(0,L.jsxs)("a",{href:"https://github.com/szmidtpiotr/claude-github-issue/blob/main/skill/SKILL.md",target:"_blank",rel:"noopener noreferrer",className:"cgi-btn",style:{textDecoration:"none",flexShrink:0,fontSize:11,gap:4},children:[(0,L.jsx)("svg",{width:"11",height:"11",viewBox:"0 0 16 16",fill:"currentColor",children:(0,L.jsx)("path",{d:"M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"})}),"View SKILL.md"]})]}),(0,L.jsxs)("div",{style:{display:"flex",gap:10,justifyContent:"flex-end"},children:[(0,L.jsx)("button",{onClick:t,className:"cgi-btn",style:{opacity:.7},children:"Cancel"}),(0,L.jsx)("button",{onClick:f,disabled:g||h,className:"cgi-btn",style:{background:h?"#22c55e":"var(--cgi-accent)",color:"#fff",border:"none",fontWeight:600},children:h?"\u2713 Saved!":g?"Saving\u2026":"Save"})]})]})]})})};var q=T(Ne());var Xe=T(H()),km={high:"#ef4444",medium:"#f59e0b",low:"#6b7280"};function Sm(e){let t=/^#?([0-9a-f]{6})$/i.exec(e);if(!t||!t[1])return null;let n=parseInt(t[1],16);return{r:n>>16&255,g:n>>8&255,b:n&255}}function bm(e){let t=e.filter(n=>!Qr.includes(n.name.toLowerCase()));return t.find(n=>n.name.toLowerCase()==="bug")??t[0]??null}var dp=({issue:e,index:t,count:n,onOpen:r,onMoveUp:o,onMoveDown:i,onDragStart:l,onDragOver:s,onDrop:a})=>{let c=Yr(e.labels),m=e.labels.some(I=>I.name.toLowerCase()==="bug"),g=e.state==="closed",p=!g&&e.labels.some(I=>I.name.toLowerCase()==="review"),v=!g&&!p?bm(e.labels):null,y=v?Sm(v.color):null,h=y?{background:`rgba(${y.r},${y.g},${y.b},0.12)`,borderColor:`rgba(${y.r},${y.g},${y.b},0.5)`}:void 0;return(0,Xe.jsxs)("div",{className:`cgi-plan-card${g?" done":""}${p?" in-review":""}`,style:h,draggable:!0,onDragStart:l,onDragOver:s,onDrop:a,children:[(0,Xe.jsx)("span",{className:"cgi-plan-drag",title:"Drag to reorder",children:"\u283F"}),c&&(0,Xe.jsx)("span",{className:"cgi-plan-dot",style:{background:km[c]}}),(0,Xe.jsxs)("button",{className:"cgi-plan-card-main",onClick:()=>r(e),children:[(0,Xe.jsxs)("span",{className:"cgi-plan-num",children:["#",e.number]}),(0,Xe.jsx)("span",{className:"cgi-plan-title",children:e.title}),p&&(0,Xe.jsx)("span",{className:"cgi-plan-review",title:"Zrobione \u2014 czeka na weryfikacj\u0119/zamkni\u0119cie",children:"\u2713 w review"}),m&&(0,Xe.jsx)("span",{className:"cgi-plan-bug",children:"bug"})]}),(0,Xe.jsxs)("span",{className:"cgi-plan-reorder",children:[(0,Xe.jsx)("button",{className:"cgi-plan-arrow",disabled:t===0,onClick:o,title:"Move up",children:"\u25B2"}),(0,Xe.jsx)("button",{className:"cgi-plan-arrow",disabled:t===n-1,onClick:i,title:"Move down",children:"\u25BC"})]})]})};var Ri=T(Ne());var lt=T(H()),pp=({projectPath:e,onClose:t,onDone:n})=>{let r=ot(),[o,i]=(0,Ri.useState)(""),[l,s]=(0,Ri.useState)(!1),[a,c]=(0,Ri.useState)(null),m=()=>{let p=[];for(let v of o.split(`
`)){let y=v.trim();if(!y)continue;let h=y.indexOf(":");if(h===-1)continue;let I=y.slice(0,h).trim(),d=y.slice(h+1).split(",").map(u=>parseInt(u.replace("#","").trim(),10)).filter(u=>Number.isFinite(u));I&&p.push({title:I,issues:d})}return p};return(0,lt.jsx)("div",{className:"cgi-modal-overlay",onClick:t,children:(0,lt.jsxs)("div",{className:"cgi-modal cgi-plan-bootstrap",onClick:p=>p.stopPropagation(),children:[(0,lt.jsx)("h3",{children:"Bootstrap phases (milestones)"}),(0,lt.jsxs)("p",{style:{fontSize:12,opacity:.6},children:["One phase per line: ",(0,lt.jsx)("code",{children:"FAZA L: 12, 14, 18"}),". Creates each milestone if missing and assigns the issues."]}),(0,lt.jsx)("textarea",{className:"cgi-plan-bootstrap-text",value:o,onChange:p=>i(p.target.value),placeholder:`FAZA A: 1, 2, 3
FAZA L: 12, 14`,rows:8}),a&&(0,lt.jsx)("div",{className:"cgi-error-text",children:a}),(0,lt.jsxs)("div",{className:"cgi-modal-actions",children:[(0,lt.jsx)("button",{className:"cgi-btn",onClick:t,disabled:l,children:"Cancel"}),(0,lt.jsx)("button",{className:"cgi-btn cgi-btn-new-issue",onClick:async()=>{let p=m();if(p.length===0){c('Enter at least one line like "FAZA L: 12, 14"');return}s(!0),c(null);try{await r.rpc("POST",`/plan/bootstrap?path=${encodeURIComponent(e)}`,{phases:p}),n()}catch(v){c(v instanceof Error?v.message:"Bootstrap failed")}finally{s(!1)}},disabled:l,children:l?"Running\u2026":"Run"})]})]})})};var W=T(H()),Cm=3e4,fp=({projectPath:e,onOpenIssue:t})=>{let n=ot(),[r,o]=(0,q.useState)(null),[i,l]=(0,q.useState)(!1),[s,a]=(0,q.useState)(null),[c,m]=(0,q.useState)(!1),g=(0,q.useRef)(null),p=(0,q.useRef)(null),v=(0,q.useRef)(null),[y,h]=(0,q.useState)(!1),[I,d]=(0,q.useState)(null),[u,f]=(0,q.useState)(()=>{try{return localStorage.getItem("cgi-plan-hide-done")!=="false"}catch{return!0}}),x=(0,q.useRef)(u);(0,q.useEffect)(()=>{x.current=u;try{localStorage.setItem("cgi-plan-hide-done",String(u))}catch{}},[u]);let[S,k]=(0,q.useState)(()=>{try{let E=localStorage.getItem("cgi-plan-collapsed");return E?new Set(JSON.parse(E)):new Set}catch{return new Set}}),C=(0,q.useCallback)(E=>{k(ee=>{let D=new Set(ee);D.has(E)?D.delete(E):D.add(E);try{localStorage.setItem("cgi-plan-collapsed",JSON.stringify([...D]))}catch{}return D})},[]),b=(0,q.useCallback)(async()=>{if(e){l(!0),a(null);try{let E=await n.rpc("GET",`/plan?path=${encodeURIComponent(e)}`);E.notConfigured?(m(!0),o(null)):E.error?a(E.error):(m(!1),o({phases:E.phases??[]}))}catch(E){a(E instanceof Error?E.message:"Failed to load plan")}finally{l(!1)}}},[n,e]);(0,q.useEffect)(()=>{b()},[b]),(0,q.useEffect)(()=>{v.current=r},[r]),(0,q.useEffect)(()=>{let E=()=>{p.current=setTimeout(()=>{b().then(E)},Cm)};return E(),()=>{p.current&&clearTimeout(p.current)}},[b]);let V=E=>E.milestoneNumber===null?"__no_phase__":String(E.milestoneNumber),M=(0,q.useCallback)((E,ee)=>{let D=v.current;if(!D)return;let de=null,oe=ue=>x.current&&ue.state==="closed",me=D.phases.map(ue=>{if(V(ue)!==E)return ue;let jt=ee(ue.issues.filter(bt=>!oe(bt))),F=ue.issues.filter(oe),xe=[...jt,...F];return de={phaseTitle:ue.milestoneNumber===null?null:ue.title,order:xe.map(bt=>bt.number)},{...ue,issues:xe}});if(!de)return;o({phases:me});let Le=de;(async()=>{try{await n.rpc("PUT",`/plan/order?path=${encodeURIComponent(e)}`,{phase:Le.phaseTitle,order:Le.order})}catch{b()}})()},[n,e,b]),Ce=(E,ee,D)=>{M(E,de=>{if(D<0||D>=de.length)return de;let oe=de.slice(),[me]=oe.splice(ee,1);return oe.splice(D,0,me),oe})},St=(0,q.useCallback)((E,ee)=>{(async()=>{try{await n.rpc("PUT",`/plan/phase?path=${encodeURIComponent(e)}`,{issue:E,milestone:ee})}finally{b()}})()},[n,e,b]),P=(E,ee)=>{let D=g.current;if(g.current=null,d(null),!D)return;if(D.phase===E){let oe=D.index<ee?ee-1:ee;if(D.index===oe)return;Ce(E,D.index,oe);return}let de=E==="__no_phase__"?null:Number(E);St(D.number,de)},A=(E,ee)=>{let D=v.current;if(!D)return;let de=D.phases.filter(F=>F.milestoneNumber!==null),oe=D.phases.filter(F=>F.milestoneNumber===null),me=E+ee;if(me<0||me>=de.length)return;let Le=de.slice(),[ue]=Le.splice(E,1);Le.splice(me,0,ue),o({phases:[...Le,...oe]});let jt=Le.map(F=>F.title);(async()=>{try{await n.rpc("PUT",`/plan/phase-order?path=${encodeURIComponent(e)}`,{order:jt})}catch{b()}})()};if(c)return(0,W.jsx)("div",{className:"cgi-center",children:(0,W.jsx)("div",{style:{opacity:.5},children:"GitHub not configured. Open the \u2699 settings on the Issues Board tab."})});if(s)return(0,W.jsxs)("div",{className:"cgi-center",children:[(0,W.jsx)("div",{className:"cgi-error-text",children:s}),(0,W.jsx)("button",{className:"cgi-btn",onClick:b,children:"Retry"})]});if(i&&!r)return(0,W.jsxs)("div",{className:"cgi-center",children:[(0,W.jsx)("div",{className:"cgi-spinner"}),(0,W.jsx)("div",{children:"Loading plan\u2026"})]});if(!r)return null;let ge=r.phases.filter(E=>E.milestoneNumber!==null).length;return(0,W.jsxs)("div",{className:"cgi-plan",children:[(0,W.jsxs)("div",{className:"cgi-plan-toolbar",children:[(0,W.jsx)("button",{className:"cgi-btn",onClick:()=>h(!0),children:"Bootstrap phases"}),(0,W.jsx)("button",{className:"cgi-btn",onClick:b,disabled:i,children:i?"\u21BB Refreshing\u2026":"\u21BB Refresh"}),(0,W.jsxs)("label",{className:"cgi-plan-toggle",children:[(0,W.jsx)("input",{type:"checkbox",checked:u,onChange:E=>f(E.target.checked)}),"Hide done"]})]}),r.phases.length===0?(0,W.jsx)("div",{className:"cgi-center",children:(0,W.jsx)("div",{style:{opacity:.5},children:"No issues yet."})}):r.phases.map((E,ee)=>{let D=V(E),de=E.total>0?Math.round(E.closed/E.total*100):0,oe=u?E.issues.filter(F=>F.state!=="closed"):E.issues;if(u&&E.total>0&&oe.length===0)return null;let me=S.has(D),Le=E.milestoneNumber!==null,ue=Le?ee:-1;return(0,W.jsxs)("section",{className:`cgi-plan-phase${I===D?" drop-target":""}`,onDragOver:F=>{!g.current||g.current.phase===D||(F.preventDefault(),I!==D&&d(D))},onDragLeave:F=>{F.currentTarget.contains(F.relatedTarget)||d(xe=>xe===D?null:xe)},onDrop:()=>P(D,oe.length),children:[(0,W.jsxs)("header",{className:"cgi-plan-phase-head",children:[(0,W.jsx)("button",{className:"cgi-plan-collapse",onClick:()=>C(D),title:me?"Rozwi\u0144 faz\u0119":"Zwi\u0144 faz\u0119",children:me?"\u25B8":"\u25BE"}),(0,W.jsx)("span",{className:"cgi-plan-phase-title",onClick:()=>C(D),children:E.title}),(0,W.jsxs)("span",{className:"cgi-plan-phase-count",children:[E.closed,"/",E.total]}),(0,W.jsx)("span",{className:"cgi-plan-progress",children:(0,W.jsx)("span",{className:"cgi-plan-progress-bar",style:{width:`${de}%`}})}),Le&&(0,W.jsxs)("span",{className:"cgi-plan-phase-reorder",children:[(0,W.jsx)("button",{className:"cgi-plan-arrow",disabled:ue===0,onClick:()=>A(ue,-1),title:"Faza wy\u017Cej",children:"\u25B2"}),(0,W.jsx)("button",{className:"cgi-plan-arrow",disabled:ue===ge-1,onClick:()=>A(ue,1),title:"Faza ni\u017Cej",children:"\u25BC"})]})]}),!me&&(0,W.jsxs)("div",{className:"cgi-plan-list",children:[oe.map((F,xe)=>(0,W.jsx)(dp,{issue:F,index:xe,count:oe.length,onOpen:t,onMoveUp:()=>Ce(D,xe,xe-1),onMoveDown:()=>Ce(D,xe,xe+1),onDragStart:()=>{g.current={phase:D,index:xe,number:F.number}},onDragOver:bt=>bt.preventDefault(),onDrop:()=>P(D,xe)},F.number)),oe.length===0&&(0,W.jsx)("div",{className:"cgi-plan-empty",children:"Przeci\u0105gnij tu ticket, by przypisa\u0107 do tej fazy"})]})]},D)}),y&&(0,W.jsx)(pp,{projectPath:e,onClose:()=>h(!1),onDone:()=>{h(!1),b()}})]})};var R=T(H()),Em=3e4,hp="cgi-collapsed-columns",gp="cgi-active-tab",mp={number:"Number",updated:"Updated",created:"Created",comments:"Comments",title:"Title",priority:"Priority"},Nm=["number","updated","created","comments","title","priority"],Pm={high:"#ef4444",medium:"#f59e0b",low:"#6b7280"};function zm(){try{let e=localStorage.getItem(hp);return e?new Set(JSON.parse(e)):new Set}catch{return new Set}}function _m(e){try{localStorage.setItem(hp,JSON.stringify([...e]))}catch{}}var vp=()=>{let e=ot(),[t,n]=(0,B.useState)(null),[r,o]=(0,B.useState)(!1),[i,l]=(0,B.useState)(null),[s,a]=(0,B.useState)(!1),[c,m]=(0,B.useState)(zm),[g,p]=(0,B.useState)(null),[v,y]=(0,B.useState)(!1),[h,I]=(0,B.useState)(!1),[d,u]=(0,B.useState)(()=>{try{return localStorage.getItem(gp)||"board"}catch{return"board"}}),f=z=>{u(z);try{localStorage.setItem(gp,z)}catch{}},[x,S]=(0,B.useState)(""),[k,C]=(0,B.useState)("all"),[b,V]=(0,B.useState)("number"),[M,Ce]=(0,B.useState)("desc"),[St,P]=(0,B.useState)(!1),[A,ge]=(0,B.useState)(new Map),[E,ee]=(0,B.useState)(!1),[D,de]=(0,B.useState)(!1),[oe,me]=(0,B.useState)(!1),[Le,ue]=(0,B.useState)(!1),jt=e.context.theme,F=e.context.project,xe=(0,B.useRef)(null),bt=(0,B.useRef)(null),$t=(0,B.useCallback)(async()=>{if(!F?.path){a(!1),n(null);return}o(!0),l(null);try{let O=await e.rpc("GET",`/issues?path=${encodeURIComponent(F.path)}`);O.notConfigured||O.error?.includes("not configured")?(a(!0),n(null)):O.error?l(O.error):(a(!1),n({issues:O.issues??[],columns:O.columns??[]}))}catch(z){let O=z instanceof Error?z.message:"Failed to load issues";O.includes("not configured")||O.includes("GitHub not configured")?(a(!0),n(null)):l(O)}finally{o(!1)}},[e,F?.path]);(0,B.useEffect)(()=>($t(),e.onContextChange(()=>{$t()})),[$t,e]),(0,B.useEffect)(()=>{F?.path&&e.rpc("GET",`/config?path=${encodeURIComponent(F.path)}`).then(z=>{ue(!!z.hasAnthropicKey)}).catch(()=>{})},[e,F?.path]),(0,B.useEffect)(()=>{let z=()=>{xe.current=setTimeout(()=>{$t().then(z)},Em)};return z(),()=>{xe.current!==null&&clearTimeout(xe.current)}},[$t]),(0,B.useEffect)(()=>{if(!St)return;let z=O=>{bt.current&&!bt.current.contains(O.target)&&P(!1)};return document.addEventListener("mousedown",z),()=>document.removeEventListener("mousedown",z)},[St]);let Sp=z=>{let O=new Map;for(let ie of z)O.set(ie.number,ie);ge(O),de(!0),V("priority"),me(!1)},bp=async()=>{if(!(!t||E||!F?.path)){ee(!0);try{let z=t.issues.filter(Ee=>Ee.state!=="closed").map(Ee=>({number:Ee.number,title:Ee.title,body:Ee.body,labels:Ee.labels,comments:Ee.comments,created_at:Ee.created_at,updated_at:Ee.updated_at,state:Ee.state})),O=await e.rpc("POST",`/ai-prioritize?path=${encodeURIComponent(F.path)}`,{issues:z}),ie=new Map;for(let Ee of O.priorities??[])ie.set(Ee.number,Ee);ge(ie),de(O.usingAI),V("priority")}catch(z){console.error("[cgi] AI prioritize failed:",z)}finally{ee(!1)}}},Cp=z=>{m(O=>{let ie=new Set(O);return ie.has(z)?ie.delete(z):ie.add(z),_m(ie),ie})},Ep=async(z,O)=>{if(!F?.path||!t)return;let ie=t.issues.find(la=>la.number===z);if(!ie)return;let Ee=Pi(ie,O);if(Ee)try{let Di=await e.rpc("PATCH",`/issues/${z}?path=${encodeURIComponent(F.path)}`,Ee);Di.ok&&Di.issue&&n(eo=>eo&&{...eo,issues:eo.issues.map(sa=>sa.number===z?Di.issue:sa)})}catch{}},Np=z=>{n(O=>O&&{...O,issues:O.issues.map(ie=>ie.number===z.number?z:ie)}),p(z)},Pp=z=>{n(O=>O&&{...O,issues:[z,...O.issues]}),I(!1),p(z)},oa=(0,B.useMemo)(()=>{if(!t)return[];let z=t.issues;if(x.trim()){let O=x.toLowerCase();z=z.filter(ie=>ie.title.toLowerCase().includes(O)||String(ie.number).includes(O)||(ie.body?.toLowerCase().includes(O)??!1))}return k!=="all"&&(z=z.filter(O=>(zi(O,A)??Yr(O.labels))===k)),Xd(z,b,M,A)},[t,x,k,b,M,A]),zp=(0,B.useMemo)(()=>t?Ni(t.issues):Cn,[t]),Mi=t?.issues.length??0,ia=oa.length,_p=ia!==Mi,Jr=F?.path??"",qr=t??{};return(0,R.jsxs)("div",{className:`cgi-root cgi-${jt}`,style:{background:"var(--cgi-bg)",color:"var(--cgi-text)"},children:[(0,R.jsxs)("div",{className:"cgi-toolbar",style:{background:"var(--cgi-surface)"},children:[(0,R.jsxs)("div",{className:"cgi-toolbar-title",children:[(0,R.jsx)("svg",{width:"16",height:"16",viewBox:"0 0 16 16",fill:"currentColor",children:(0,R.jsx)("path",{d:"M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"})}),"GitHub Issues Board",qr.owner&&qr.repo&&(0,R.jsxs)("span",{style:{fontWeight:400,opacity:.6,fontSize:12},children:[qr.owner,"/",qr.repo]}),t&&(0,R.jsx)("span",{style:{fontSize:11,opacity:.45},children:_p?`${ia}/${Mi}`:`${Mi}`})]}),(0,R.jsxs)("div",{className:"cgi-tabs",children:[(0,R.jsx)("button",{className:`cgi-tab${d==="board"?" active":""}`,onClick:()=>f("board"),children:"Issues Board"}),(0,R.jsx)("button",{className:`cgi-tab${d==="plan"?" active":""}`,onClick:()=>f("plan"),children:"Plan"})]}),(0,R.jsxs)("div",{className:"cgi-toolbar-actions",children:[F&&!s&&(0,R.jsxs)("button",{className:"cgi-btn cgi-btn-new-issue",onClick:()=>I(!0),title:"Create a new issue",children:[(0,R.jsx)("svg",{width:"12",height:"12",viewBox:"0 0 16 16",fill:"currentColor",children:(0,R.jsx)("path",{d:"M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"})}),"New Issue"]}),t&&F&&(0,R.jsxs)("button",{className:`cgi-btn cgi-btn-ai${E?" cgi-btn-ai-loading":""}`,onClick:bp,disabled:E,title:Le?"AI Prioritize \u2014 using Anthropic Claude API":"AI Prioritize \u2014 using smart heuristics (add Anthropic API key in \u2699 settings for real AI)",children:[(0,R.jsx)("svg",{width:"13",height:"13",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:"2",children:(0,R.jsx)("path",{d:"M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"})}),E?"Analyzing\u2026":D?"Re-prioritize":"AI Prioritize"]}),(0,R.jsx)("button",{className:"cgi-btn",onClick:$t,disabled:r,title:"Refresh issues",children:r?"\u21BB Refreshing\u2026":"\u21BB Refresh"}),F&&(0,R.jsx)("button",{className:"cgi-btn",onClick:()=>y(!0),title:"Settings",style:{padding:"4px 8px"},children:"\u2699"})]})]}),d==="board"&&t&&(0,R.jsxs)("div",{className:"cgi-filterbar",style:{background:"var(--cgi-surface)",borderBottom:"1px solid var(--cgi-border)"},children:[(0,R.jsxs)("div",{className:"cgi-search-wrap",children:[(0,R.jsx)("svg",{className:"cgi-search-icon",width:"13",height:"13",viewBox:"0 0 16 16",fill:"currentColor",children:(0,R.jsx)("path",{d:"M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"})}),(0,R.jsx)("input",{type:"text",className:"cgi-search-input",placeholder:"Search issues\u2026",value:x,onChange:z=>S(z.target.value)}),x&&(0,R.jsx)("button",{className:"cgi-search-clear",onClick:()=>S(""),title:"Clear search",children:"\u2715"})]}),(0,R.jsx)("div",{className:"cgi-priority-pills",children:["all","high","medium","low"].map(z=>(0,R.jsxs)("button",{className:`cgi-priority-pill${k===z?" active":""}`,onClick:()=>C(z),children:[z!=="all"&&(0,R.jsx)("span",{className:"cgi-priority-pill-dot",style:{background:Pm[z]}}),z==="all"?"All":z.charAt(0).toUpperCase()+z.slice(1)]},z))}),(0,R.jsxs)("div",{className:"cgi-sort-controls",ref:bt,children:[(0,R.jsx)("button",{className:"cgi-btn cgi-sort-dir-btn",onClick:()=>Ce(z=>z==="desc"?"asc":"desc"),title:M==="desc"?"Descending \u2014 click for ascending":"Ascending \u2014 click for descending",children:M==="desc"?"\u2193":"\u2191"}),(0,R.jsxs)("div",{style:{position:"relative"},children:[(0,R.jsxs)("button",{className:"cgi-btn cgi-sort-select-btn",onClick:()=>P(z=>!z),children:["Sort: ",mp[b]," ",(0,R.jsx)("span",{style:{opacity:.5,marginLeft:2},children:"\u2228"})]}),St&&(0,R.jsx)("div",{className:"cgi-sort-menu",children:Nm.map(z=>(0,R.jsx)("button",{className:`cgi-sort-menu-item${b===z?" active":""}`,onClick:()=>{V(z),P(!1)},children:mp[z]},z))})]})]})]}),d==="plan"?F?(0,R.jsx)(fp,{projectPath:Jr,onOpenIssue:p}):(0,R.jsx)("div",{className:"cgi-center",children:(0,R.jsx)("div",{style:{opacity:.5},children:"No project open."})}):F?s?(0,R.jsx)(up,{onOpenSettings:()=>y(!0)}):r&&!t?(0,R.jsxs)("div",{className:"cgi-center",children:[(0,R.jsx)("div",{className:"cgi-spinner"}),(0,R.jsx)("div",{children:"Loading issues\u2026"})]}):i?(0,R.jsxs)("div",{className:"cgi-center",children:[(0,R.jsx)("div",{className:"cgi-error-text",children:i}),(0,R.jsx)("button",{className:"cgi-btn",onClick:$t,children:"Retry"})]}):t?(0,R.jsx)(ep,{issues:oa,priorityMap:A,collapsedColumns:c,onToggleColumn:Cp,onMoveIssue:Ep,onOpenIssue:p}):null:(0,R.jsxs)("div",{className:"cgi-center",children:[(0,R.jsx)("div",{style:{opacity:.5},children:"No project open."}),(0,R.jsx)("div",{style:{fontSize:12,opacity:.4},children:"Open a project to view its GitHub Issues."})]}),g&&F&&(0,R.jsx)(lp,{issue:g,projectPath:Jr,columns:zp,onClose:()=>p(null),onIssueUpdated:Np}),v&&F&&(0,R.jsx)(cp,{projectPath:Jr,onClose:()=>y(!1),onSaved:()=>{a(!1),y(!1),$t()},onManualPrioritize:t?()=>{y(!1),me(!0)}:void 0}),oe&&t&&(0,R.jsx)(ap,{issues:t.issues,onApply:Sp,onClose:()=>me(!1)}),h&&F&&(0,R.jsx)(sp,{projectPath:Jr,onClose:()=>I(!1),onCreated:Pp})]})};var yp=`/* claude-github-issue plugin styles */\r
\r
.cgi-root {\r
  display: flex;\r
  flex-direction: column;\r
  height: 100%;\r
  width: 100%;\r
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;\r
  font-size: 13px;\r
  overflow: hidden;\r
}\r
\r
/* Toolbar */\r
.cgi-toolbar {\r
  display: flex;\r
  align-items: center;\r
  justify-content: space-between;\r
  padding: 8px 16px;\r
  border-bottom: 1px solid var(--cgi-border);\r
  flex-shrink: 0;\r
  gap: 8px;\r
}\r
\r
.cgi-toolbar-title {\r
  font-weight: 600;\r
  font-size: 14px;\r
  display: flex;\r
  align-items: center;\r
  gap: 8px;\r
}\r
\r
.cgi-toolbar-actions {\r
  display: flex;\r
  align-items: center;\r
  gap: 6px;\r
}\r
\r
.cgi-btn {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: 4px;\r
  padding: 4px 10px;\r
  border-radius: 6px;\r
  border: 1px solid var(--cgi-border);\r
  background: var(--cgi-btn-bg);\r
  color: var(--cgi-text);\r
  font-size: 12px;\r
  cursor: pointer;\r
  transition: background 0.15s, border-color 0.15s;\r
  white-space: nowrap;\r
}\r
\r
.cgi-btn:hover {\r
  background: var(--cgi-btn-hover-bg);\r
  border-color: var(--cgi-border-strong);\r
}\r
\r
.cgi-btn:disabled {\r
  opacity: 0.5;\r
  cursor: default;\r
}\r
\r
.cgi-btn-primary {\r
  background: var(--cgi-accent);\r
  border-color: var(--cgi-accent);\r
  color: #fff;\r
}\r
\r
.cgi-btn-primary:hover {\r
  background: var(--cgi-accent-hover);\r
  border-color: var(--cgi-accent-hover);\r
}\r
\r
/* Board */\r
.cgi-board-wrap {\r
  display: flex;\r
  flex-direction: column;\r
  flex: 1;\r
  min-height: 0;\r
}\r
\r
.cgi-board {\r
  display: grid;\r
  gap: 10px;\r
  padding: 12px 16px;\r
  flex: 1;\r
  min-height: 0;\r
  overflow-x: auto;\r
  overflow-y: hidden;\r
  align-items: stretch;\r
}\r
\r
/* Collapsed-column pills (mobile) */\r
.cgi-collapsed-bar {\r
  display: flex;\r
  flex-wrap: wrap;\r
  gap: 6px;\r
  padding: 10px 16px 0;\r
  flex-shrink: 0;\r
}\r
\r
.cgi-collapsed-chip {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: 6px;\r
  padding: 5px 10px;\r
  border-radius: 999px;\r
  border: 1px solid;\r
  font-size: 11px;\r
  font-weight: 600;\r
  letter-spacing: 0.04em;\r
  text-transform: uppercase;\r
  cursor: pointer;\r
  white-space: nowrap;\r
  transition: filter 0.15s;\r
}\r
\r
.cgi-collapsed-chip:hover {\r
  filter: brightness(1.15);\r
}\r
\r
.cgi-collapsed-chip-dot {\r
  width: 7px;\r
  height: 7px;\r
  border-radius: 50%;\r
  flex-shrink: 0;\r
}\r
\r
.cgi-collapsed-chip-count {\r
  font-size: 10px;\r
  font-weight: 700;\r
  background: rgba(0, 0, 0, 0.2);\r
  border-radius: 9px;\r
  padding: 0 5px;\r
  min-width: 16px;\r
  text-align: center;\r
}\r
\r
/* Column */\r
.cgi-column {\r
  display: flex;\r
  flex-direction: column;\r
  border-radius: 10px;\r
  border: 1px solid var(--cgi-border);\r
  overflow: hidden;\r
  min-height: 0;\r
  transition: width 0.2s, min-width 0.2s;\r
}\r
\r
.cgi-column-header {\r
  display: flex;\r
  align-items: center;\r
  justify-content: space-between;\r
  padding: 8px 10px;\r
  font-weight: 600;\r
  font-size: 12px;\r
  letter-spacing: 0.04em;\r
  text-transform: uppercase;\r
  flex-shrink: 0;\r
  gap: 6px;\r
  cursor: pointer;\r
  user-select: none;\r
}\r
\r
.cgi-column-header:hover {\r
  opacity: 0.85;\r
}\r
\r
.cgi-column-count {\r
  display: inline-flex;\r
  align-items: center;\r
  justify-content: center;\r
  min-width: 20px;\r
  height: 18px;\r
  padding: 0 5px;\r
  border-radius: 9px;\r
  font-size: 10px;\r
  font-weight: 700;\r
  background: rgba(0,0,0,0.15);\r
}\r
\r
.cgi-column-toggle {\r
  width: 18px;\r
  height: 18px;\r
  display: flex;\r
  align-items: center;\r
  justify-content: center;\r
  border-radius: 4px;\r
  margin-left: auto;\r
  flex-shrink: 0;\r
  opacity: 0.7;\r
  font-size: 10px;\r
}\r
\r
.cgi-column-body {\r
  flex: 1;\r
  overflow-y: auto;\r
  padding: 6px;\r
  display: flex;\r
  flex-direction: column;\r
  gap: 6px;\r
  min-height: 0;\r
}\r
\r
.cgi-column-collapsed-label {\r
  writing-mode: vertical-rl;\r
  text-orientation: mixed;\r
  transform: rotate(180deg);\r
  white-space: nowrap;\r
  overflow: hidden;\r
  text-overflow: ellipsis;\r
  font-size: 11px;\r
  font-weight: 600;\r
  letter-spacing: 0.06em;\r
  text-transform: uppercase;\r
  opacity: 0.8;\r
  padding: 12px 0;\r
  flex: 1;\r
}\r
\r
/* Issue card */\r
.cgi-card {\r
  background: var(--cgi-card-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 8px;\r
  padding: 8px 10px;\r
  cursor: grab;\r
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s, opacity 0.15s;\r
}\r
\r
.cgi-card:hover {\r
  border-color: var(--cgi-border-strong);\r
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);\r
  transform: translateY(-1px);\r
}\r
\r
.cgi-card--dragging {\r
  opacity: 0.35;\r
  transform: scale(0.98);\r
  cursor: grabbing;\r
}\r
\r
.cgi-column-body--drag-over {\r
  background: rgba(255,255,255,0.03);\r
}\r
\r
.cgi-column-empty {\r
  text-align: center;\r
  padding: 20px 0;\r
  opacity: 0.4;\r
  font-size: 12px;\r
  transition: opacity 0.15s;\r
}\r
\r
.cgi-column-empty--drag-over {\r
  opacity: 0.9;\r
  font-weight: 600;\r
}\r
\r
.cgi-card-title {\r
  font-weight: 500;\r
  font-size: 13px;\r
  line-height: 1.4;\r
  margin-bottom: 6px;\r
  color: var(--cgi-text);\r
  word-break: break-word;\r
}\r
\r
.cgi-card-meta {\r
  display: flex;\r
  align-items: center;\r
  gap: 6px;\r
  flex-wrap: wrap;\r
}\r
\r
.cgi-card-number {\r
  font-size: 11px;\r
  color: var(--cgi-text-muted);\r
  font-weight: 500;\r
}\r
\r
.cgi-card-labels {\r
  display: flex;\r
  flex-wrap: wrap;\r
  gap: 3px;\r
  margin-top: 5px;\r
}\r
\r
.cgi-label-chip {\r
  display: inline-block;\r
  padding: 1px 6px;\r
  border-radius: 10px;\r
  font-size: 10px;\r
  font-weight: 600;\r
  line-height: 1.6;\r
}\r
\r
.cgi-avatar {\r
  width: 18px;\r
  height: 18px;\r
  border-radius: 50%;\r
  object-fit: cover;\r
  flex-shrink: 0;\r
}\r
\r
.cgi-card-comments {\r
  display: flex;\r
  align-items: center;\r
  gap: 3px;\r
  font-size: 11px;\r
  color: var(--cgi-text-muted);\r
  margin-left: auto;\r
}\r
\r
/* Modal */\r
.cgi-modal-overlay {\r
  position: fixed;\r
  inset: 0;\r
  background: rgba(0,0,0,0.55);\r
  display: flex;\r
  align-items: center;\r
  justify-content: center;\r
  z-index: 9999;\r
  overflow: hidden;\r
}\r
\r
.cgi-modal {\r
  background: var(--cgi-modal-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 12px;\r
  box-shadow: 0 20px 60px rgba(0,0,0,0.4);\r
  display: flex;\r
  flex-direction: column;\r
  position: relative;\r
  overflow: hidden;\r
  height: auto;\r
}\r
\r
.cgi-resize-e,\r
.cgi-resize-s,\r
.cgi-resize-se {\r
  position: absolute;\r
  z-index: 20;\r
}\r
\r
.cgi-resize-e {\r
  top: 40px;\r
  right: 0;\r
  bottom: 20px;\r
  width: 6px;\r
  cursor: ew-resize;\r
}\r
\r
.cgi-resize-s {\r
  bottom: 0;\r
  left: 20px;\r
  right: 20px;\r
  height: 6px;\r
  cursor: ns-resize;\r
}\r
\r
.cgi-resize-se {\r
  bottom: 0;\r
  right: 0;\r
  width: 20px;\r
  height: 20px;\r
  cursor: nwse-resize;\r
}\r
\r
.cgi-resize-e:hover,\r
.cgi-resize-s:hover {\r
  background: rgba(255,255,255,0.07);\r
}\r
\r
.cgi-resize-se::after {\r
  content: '';\r
  position: absolute;\r
  bottom: 4px;\r
  right: 4px;\r
  width: 10px;\r
  height: 10px;\r
  background-image: radial-gradient(circle, var(--cgi-text-muted) 1.2px, transparent 1.2px);\r
  background-size: 4px 4px;\r
  opacity: 0.45;\r
}\r
\r
.cgi-modal-header {\r
  display: flex;\r
  align-items: flex-start;\r
  gap: 10px;\r
  padding: 18px 20px 14px;\r
  border-bottom: 1px solid var(--cgi-border);\r
}\r
\r
.cgi-modal-title {\r
  flex: 1;\r
  font-size: 16px;\r
  font-weight: 600;\r
  line-height: 1.4;\r
  color: var(--cgi-text);\r
}\r
\r
.cgi-modal-subtitle {\r
  font-size: 12px;\r
  color: var(--cgi-text-muted);\r
  margin-top: 2px;\r
}\r
\r
.cgi-modal-close {\r
  background: none;\r
  border: none;\r
  color: var(--cgi-text-muted);\r
  font-size: 20px;\r
  cursor: pointer;\r
  padding: 0 4px;\r
  line-height: 1;\r
  border-radius: 4px;\r
  flex-shrink: 0;\r
}\r
\r
.cgi-modal-close:hover {\r
  color: var(--cgi-text);\r
  background: var(--cgi-btn-bg);\r
}\r
\r
.cgi-modal-body {\r
  padding: 16px 20px;\r
  display: flex;\r
  flex-direction: column;\r
  gap: 16px;\r
  flex: 1;\r
  min-height: 0;\r
  overflow-y: auto;\r
}\r
\r
.cgi-modal-section-label {\r
  font-size: 11px;\r
  font-weight: 600;\r
  text-transform: uppercase;\r
  letter-spacing: 0.06em;\r
  color: var(--cgi-text-muted);\r
  margin-bottom: 6px;\r
}\r
\r
.cgi-issue-body {\r
  font-size: 13px;\r
  line-height: 1.6;\r
  color: var(--cgi-text);\r
  word-break: break-word;\r
  overflow: hidden;\r
}\r
\r
.cgi-column-selector {\r
  display: flex;\r
  gap: 6px;\r
  flex-wrap: wrap;\r
}\r
\r
.cgi-column-btn {\r
  padding: 4px 12px;\r
  border-radius: 20px;\r
  border: 1px solid var(--cgi-border);\r
  background: var(--cgi-btn-bg);\r
  color: var(--cgi-text);\r
  font-size: 12px;\r
  cursor: pointer;\r
  transition: all 0.15s;\r
}\r
\r
.cgi-column-btn:hover {\r
  border-color: var(--cgi-border-strong);\r
  background: var(--cgi-btn-hover-bg);\r
}\r
\r
.cgi-column-btn-active {\r
  color: #fff;\r
  border-color: transparent;\r
}\r
\r
/* Comments */\r
.cgi-comments-list {\r
  display: flex;\r
  flex-direction: column;\r
  gap: 10px;\r
}\r
\r
.cgi-comment {\r
  background: var(--cgi-code-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 8px;\r
  padding: 10px 12px;\r
}\r
\r
.cgi-comment-header {\r
  display: flex;\r
  align-items: center;\r
  gap: 6px;\r
  margin-bottom: 6px;\r
  font-size: 11px;\r
  color: var(--cgi-text-muted);\r
}\r
\r
.cgi-comment-author {\r
  font-weight: 600;\r
  color: var(--cgi-text);\r
}\r
\r
.cgi-comment-body {\r
  font-size: 13px;\r
  line-height: 1.5;\r
  word-break: break-word;\r
  color: var(--cgi-text);\r
}\r
\r
/* ---------------------------------------------------------------------------\r
   Markdown rendering (Markdown.tsx) \u2014 GitHub-flavored subset\r
   --------------------------------------------------------------------------- */\r
.cgi-md {\r
  color: var(--cgi-text);\r
  word-break: break-word;\r
}\r
\r
.cgi-md > *:first-child { margin-top: 0; }\r
.cgi-md > *:last-child { margin-bottom: 0; }\r
\r
.cgi-md-p {\r
  margin: 0 0 10px;\r
  line-height: 1.6;\r
}\r
\r
.cgi-md-h {\r
  margin: 18px 0 10px;\r
  font-weight: 600;\r
  line-height: 1.3;\r
  color: var(--cgi-text);\r
}\r
.cgi-md-h1 { font-size: 20px; padding-bottom: 6px; border-bottom: 1px solid var(--cgi-border); }\r
.cgi-md-h2 { font-size: 17px; padding-bottom: 5px; border-bottom: 1px solid var(--cgi-border); }\r
.cgi-md-h3 { font-size: 15px; }\r
.cgi-md-h4 { font-size: 14px; }\r
.cgi-md-h5 { font-size: 13px; }\r
.cgi-md-h6 { font-size: 13px; color: var(--cgi-text-muted); }\r
\r
.cgi-md-link {\r
  color: var(--cgi-accent);\r
  text-decoration: none;\r
}\r
.cgi-md-link:hover { text-decoration: underline; }\r
\r
.cgi-md-code {\r
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\r
  font-size: 0.86em;\r
  background: var(--cgi-code-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 4px;\r
  padding: 1px 5px;\r
  white-space: break-spaces;\r
}\r
\r
.cgi-md-pre {\r
  background: var(--cgi-code-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 8px;\r
  padding: 12px;\r
  overflow-x: auto;\r
  margin: 0 0 12px;\r
}\r
.cgi-md-pre code {\r
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\r
  font-size: 12px;\r
  line-height: 1.5;\r
  white-space: pre;\r
  background: none;\r
  border: none;\r
  padding: 0;\r
  color: var(--cgi-text);\r
}\r
\r
.cgi-md-ul,\r
.cgi-md-ol {\r
  margin: 0 0 10px;\r
  padding-left: 22px;\r
}\r
.cgi-md-ul { list-style: disc; }\r
.cgi-md-ol { list-style: decimal; }\r
.cgi-md-ul li,\r
.cgi-md-ol li {\r
  margin: 3px 0;\r
  line-height: 1.55;\r
}\r
\r
.cgi-md-quote {\r
  margin: 0 0 12px;\r
  padding: 2px 12px;\r
  border-left: 3px solid var(--cgi-border-strong);\r
  color: var(--cgi-text-muted);\r
}\r
\r
.cgi-md-hr {\r
  border: none;\r
  border-top: 1px solid var(--cgi-border);\r
  margin: 16px 0;\r
}\r
\r
.cgi-md-table-wrap {\r
  overflow-x: auto;\r
  margin: 0 0 12px;\r
}\r
.cgi-md-table {\r
  border-collapse: collapse;\r
  font-size: 12.5px;\r
  width: auto;\r
}\r
.cgi-md-table th,\r
.cgi-md-table td {\r
  border: 1px solid var(--cgi-border);\r
  padding: 6px 11px;\r
  text-align: left;\r
  vertical-align: top;\r
}\r
.cgi-md-table th {\r
  background: var(--cgi-code-bg);\r
  font-weight: 600;\r
}\r
.cgi-md-table tr:nth-child(even) td {\r
  background: var(--cgi-code-bg);\r
}\r
\r
/* Comment form */\r
.cgi-comment-form {\r
  display: flex;\r
  flex-direction: column;\r
  gap: 8px;\r
}\r
\r
.cgi-textarea {\r
  width: 100%;\r
  min-height: 72px;\r
  padding: 8px 10px;\r
  background: var(--cgi-input-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 8px;\r
  color: var(--cgi-text);\r
  font-size: 13px;\r
  font-family: inherit;\r
  resize: vertical;\r
  box-sizing: border-box;\r
  transition: border-color 0.15s;\r
  outline: none;\r
}\r
\r
.cgi-textarea:focus {\r
  border-color: var(--cgi-accent);\r
}\r
\r
/* Config banner */\r
.cgi-config-banner {\r
  display: flex;\r
  flex-direction: column;\r
  align-items: center;\r
  justify-content: center;\r
  height: 100%;\r
  padding: 40px 20px;\r
  text-align: center;\r
  gap: 16px;\r
  color: var(--cgi-text);\r
}\r
\r
.cgi-config-banner-icon {\r
  font-size: 48px;\r
  opacity: 0.5;\r
}\r
\r
.cgi-config-banner h2 {\r
  font-size: 18px;\r
  font-weight: 600;\r
  margin: 0;\r
}\r
\r
.cgi-config-banner p {\r
  color: var(--cgi-text-muted);\r
  max-width: 420px;\r
  line-height: 1.6;\r
  margin: 0;\r
}\r
\r
.cgi-config-code {\r
  background: var(--cgi-code-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 8px;\r
  padding: 14px 18px;\r
  font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;\r
  font-size: 12px;\r
  text-align: left;\r
  white-space: pre;\r
  color: var(--cgi-text);\r
  max-width: 380px;\r
  width: 100%;\r
}\r
\r
/* Loading / error states */\r
.cgi-center {\r
  display: flex;\r
  align-items: center;\r
  justify-content: center;\r
  height: 100%;\r
  flex-direction: column;\r
  gap: 12px;\r
  color: var(--cgi-text-muted);\r
}\r
\r
.cgi-spinner {\r
  width: 28px;\r
  height: 28px;\r
  border: 3px solid var(--cgi-border);\r
  border-top-color: var(--cgi-accent);\r
  border-radius: 50%;\r
  animation: cgi-spin 0.8s linear infinite;\r
}\r
\r
@keyframes cgi-spin {\r
  to { transform: rotate(360deg); }\r
}\r
\r
.cgi-error-text {\r
  color: #ef4444;\r
  font-size: 13px;\r
}\r
\r
/* Scrollbars */\r
.cgi-root *::-webkit-scrollbar {\r
  width: 6px;\r
  height: 6px;\r
}\r
.cgi-root *::-webkit-scrollbar-track {\r
  background: transparent;\r
}\r
.cgi-root *::-webkit-scrollbar-thumb {\r
  background: var(--cgi-scrollbar);\r
  border-radius: 3px;\r
}\r
\r
/* Dark theme variables */\r
.cgi-dark {\r
  --cgi-bg: #0f1117;\r
  --cgi-surface: #161b22;\r
  --cgi-card-bg: #1a2030;\r
  --cgi-modal-bg: #161b22;\r
  --cgi-code-bg: #0d1117;\r
  --cgi-border: rgba(255,255,255,0.1);\r
  --cgi-border-strong: rgba(255,255,255,0.2);\r
  --cgi-text: #e6edf3;\r
  --cgi-text-muted: #7d8590;\r
  --cgi-btn-bg: rgba(255,255,255,0.06);\r
  --cgi-btn-hover-bg: rgba(255,255,255,0.12);\r
  --cgi-input-bg: #0d1117;\r
  --cgi-accent: #2563eb;\r
  --cgi-accent-hover: #1d4ed8;\r
  --cgi-scrollbar: rgba(255,255,255,0.15);\r
}\r
\r
/* New Issue button */\r
.cgi-btn-new-issue {\r
  background: var(--cgi-accent);\r
  color: #fff;\r
  border-color: var(--cgi-accent);\r
  font-weight: 600;\r
  gap: 5px;\r
}\r
.cgi-btn-new-issue:hover {\r
  background: var(--cgi-accent-hover);\r
  border-color: var(--cgi-accent-hover);\r
}\r
\r
/* AI Prioritize button */\r
.cgi-btn-ai {\r
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);\r
  color: #fff;\r
  border-color: transparent;\r
  font-weight: 600;\r
  gap: 5px;\r
}\r
.cgi-btn-ai:hover {\r
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);\r
  border-color: transparent;\r
}\r
.cgi-btn-ai-loading {\r
  opacity: 0.75;\r
}\r
\r
/* AI button split group */\r
.cgi-ai-btn-group {\r
  display: flex;\r
  align-items: stretch;\r
}\r
\r
.cgi-btn-ai-sub {\r
  opacity: 0.85;\r
  font-size: 11px !important;\r
  letter-spacing: 0.01em;\r
  border-left: 1px solid rgba(255,255,255,0.2) !important;\r
}\r
\r
.cgi-btn-ai-sub:hover {\r
  opacity: 1;\r
}\r
\r
/* Filter bar */\r
.cgi-filterbar {\r
  display: flex;\r
  align-items: center;\r
  gap: 8px;\r
  padding: 6px 14px;\r
  flex-shrink: 0;\r
  flex-wrap: wrap;\r
}\r
\r
/* Search */\r
.cgi-search-wrap {\r
  position: relative;\r
  display: flex;\r
  align-items: center;\r
  flex-shrink: 0;\r
}\r
\r
.cgi-search-icon {\r
  position: absolute;\r
  left: 8px;\r
  color: var(--cgi-text-muted);\r
  pointer-events: none;\r
}\r
\r
.cgi-search-input {\r
  padding: 4px 28px 4px 26px;\r
  background: var(--cgi-input-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 6px;\r
  color: var(--cgi-text);\r
  font-size: 12px;\r
  outline: none;\r
  width: 160px;\r
  transition: border-color 0.15s, width 0.2s;\r
}\r
\r
.cgi-search-input:focus {\r
  border-color: var(--cgi-accent);\r
  width: 200px;\r
}\r
\r
.cgi-search-input::placeholder {\r
  color: var(--cgi-text-muted);\r
}\r
\r
.cgi-search-clear {\r
  position: absolute;\r
  right: 6px;\r
  background: none;\r
  border: none;\r
  cursor: pointer;\r
  color: var(--cgi-text-muted);\r
  font-size: 11px;\r
  padding: 1px 2px;\r
  line-height: 1;\r
  border-radius: 3px;\r
}\r
.cgi-search-clear:hover {\r
  color: var(--cgi-text);\r
}\r
\r
/* Priority pills */\r
.cgi-priority-pills {\r
  display: flex;\r
  gap: 4px;\r
  align-items: center;\r
}\r
\r
.cgi-priority-pill {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: 5px;\r
  padding: 3px 10px;\r
  border-radius: 20px;\r
  border: 1px solid var(--cgi-border);\r
  background: var(--cgi-btn-bg);\r
  color: var(--cgi-text);\r
  font-size: 12px;\r
  font-weight: 500;\r
  cursor: pointer;\r
  transition: all 0.15s;\r
  white-space: nowrap;\r
}\r
\r
.cgi-priority-pill:hover {\r
  border-color: var(--cgi-border-strong);\r
  background: var(--cgi-btn-hover-bg);\r
}\r
\r
.cgi-priority-pill.active {\r
  background: var(--cgi-accent);\r
  border-color: var(--cgi-accent);\r
  color: #fff;\r
}\r
\r
.cgi-priority-pill-dot {\r
  width: 7px;\r
  height: 7px;\r
  border-radius: 50%;\r
  flex-shrink: 0;\r
}\r
\r
.cgi-priority-pill.active .cgi-priority-pill-dot {\r
  background: rgba(255,255,255,0.8) !important;\r
}\r
\r
/* Sort controls */\r
.cgi-sort-controls {\r
  display: flex;\r
  align-items: center;\r
  gap: 4px;\r
  margin-left: auto;\r
  position: relative;\r
}\r
\r
.cgi-sort-dir-btn {\r
  font-size: 14px;\r
  font-weight: 600;\r
  padding: 3px 8px;\r
  min-width: 28px;\r
  justify-content: center;\r
}\r
\r
.cgi-sort-select-btn {\r
  white-space: nowrap;\r
  min-width: 120px;\r
  justify-content: space-between;\r
}\r
\r
.cgi-sort-menu {\r
  position: absolute;\r
  top: calc(100% + 4px);\r
  right: 0;\r
  background: var(--cgi-modal-bg);\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 8px;\r
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);\r
  z-index: 100;\r
  min-width: 130px;\r
  overflow: hidden;\r
}\r
\r
.cgi-sort-menu-item {\r
  display: block;\r
  width: 100%;\r
  text-align: left;\r
  padding: 7px 14px;\r
  background: none;\r
  border: none;\r
  color: var(--cgi-text);\r
  font-size: 13px;\r
  cursor: pointer;\r
  transition: background 0.1s;\r
}\r
\r
.cgi-sort-menu-item:hover {\r
  background: var(--cgi-btn-hover-bg);\r
}\r
\r
.cgi-sort-menu-item.active {\r
  color: var(--cgi-accent);\r
  font-weight: 600;\r
}\r
\r
/* Priority dot on card */\r
.cgi-card-title-row {\r
  display: flex;\r
  align-items: flex-start;\r
  gap: 6px;\r
  margin-bottom: 6px;\r
}\r
\r
.cgi-card-title-row .cgi-card-title {\r
  margin-bottom: 0;\r
  flex: 1;\r
}\r
\r
.cgi-priority-dot {\r
  width: 8px;\r
  height: 8px;\r
  border-radius: 50%;\r
  flex-shrink: 0;\r
  margin-top: 4px;\r
  cursor: help;\r
}\r
\r
/* Image thumbnails on cards */\r
.cgi-card-thumbs {\r
  display: flex;\r
  gap: 4px;\r
  align-items: center;\r
  margin-bottom: 6px;\r
  flex-wrap: wrap;\r
}\r
\r
.cgi-card-thumb {\r
  width: 52px;\r
  height: 38px;\r
  object-fit: cover;\r
  border-radius: 4px;\r
  border: 1px solid var(--cgi-border);\r
  background: var(--cgi-code-bg);\r
  pointer-events: none;\r
}\r
\r
.cgi-card-thumb-more {\r
  font-size: 10px;\r
  font-weight: 600;\r
  color: var(--cgi-text-muted);\r
  padding: 0 4px;\r
}\r
\r
/* Image grid in modal / comments */\r
.cgi-img-grid {\r
  display: flex;\r
  flex-wrap: wrap;\r
  gap: 6px;\r
  margin-bottom: 8px;\r
}\r
\r
.cgi-img-thumb-btn {\r
  background: none;\r
  border: 1px solid var(--cgi-border);\r
  border-radius: 6px;\r
  padding: 0;\r
  cursor: zoom-in;\r
  overflow: hidden;\r
  transition: border-color 0.15s, box-shadow 0.15s;\r
  flex-shrink: 0;\r
}\r
\r
.cgi-img-thumb-btn:hover {\r
  border-color: var(--cgi-accent);\r
  box-shadow: 0 0 0 2px rgba(37,99,235,0.25);\r
}\r
\r
.cgi-img-thumb {\r
  display: block;\r
  width: auto;\r
  height: 80px;\r
  max-width: 200px;\r
  object-fit: cover;\r
}\r
\r
/* Lightbox */\r
.cgi-lightbox-overlay {\r
  position: fixed;\r
  inset: 0;\r
  background: rgba(0,0,0,0.88);\r
  z-index: 99999;\r
  display: flex;\r
  align-items: center;\r
  justify-content: center;\r
  cursor: zoom-out;\r
  padding: 24px;\r
}\r
\r
.cgi-lightbox-img {\r
  max-width: 100%;\r
  max-height: 90vh;\r
  object-fit: contain;\r
  border-radius: 8px;\r
  box-shadow: 0 8px 40px rgba(0,0,0,0.6);\r
  cursor: default;\r
}\r
\r
.cgi-lightbox-close {\r
  position: fixed;\r
  top: 16px;\r
  right: 20px;\r
  background: rgba(255,255,255,0.1);\r
  border: 1px solid rgba(255,255,255,0.2);\r
  color: #fff;\r
  font-size: 20px;\r
  width: 36px;\r
  height: 36px;\r
  border-radius: 50%;\r
  cursor: pointer;\r
  display: flex;\r
  align-items: center;\r
  justify-content: center;\r
  z-index: 100000;\r
  transition: background 0.15s;\r
  line-height: 1;\r
  padding: 0;\r
}\r
\r
.cgi-lightbox-close:hover {\r
  background: rgba(255,255,255,0.2);\r
}\r
\r
.cgi-lightbox-error {\r
  display: flex;\r
  flex-direction: column;\r
  align-items: center;\r
  color: #fff;\r
  cursor: default;\r
  text-align: center;\r
}\r
\r
/* Light theme variables */\r
.cgi-light {\r
  --cgi-bg: #f6f8fa;\r
  --cgi-surface: #ffffff;\r
  --cgi-card-bg: #ffffff;\r
  --cgi-modal-bg: #ffffff;\r
  --cgi-code-bg: #f6f8fa;\r
  --cgi-border: rgba(0,0,0,0.1);\r
  --cgi-border-strong: rgba(0,0,0,0.22);\r
  --cgi-text: #1f2328;\r
  --cgi-text-muted: #636c76;\r
  --cgi-btn-bg: rgba(0,0,0,0.04);\r
  --cgi-btn-hover-bg: rgba(0,0,0,0.08);\r
  --cgi-input-bg: #ffffff;\r
  --cgi-accent: #2563eb;\r
  --cgi-accent-hover: #1d4ed8;\r
  --cgi-scrollbar: rgba(0,0,0,0.15);\r
}\r
\r
/* Tab switcher */\r
.cgi-tabs { display: flex; gap: 4px; margin-left: 12px; }\r
.cgi-tab {\r
  background: transparent; border: none; color: var(--cgi-text);\r
  opacity: 0.55; padding: 6px 12px; font-size: 13px; cursor: pointer;\r
  border-bottom: 2px solid transparent;\r
}\r
.cgi-tab:hover { opacity: 0.85; }\r
.cgi-tab.active { opacity: 1; border-bottom-color: var(--cgi-accent, #0ea5e9); font-weight: 600; }\r
\r
/* Plan view */\r
.cgi-plan { padding: 12px 16px; overflow-y: auto; }\r
.cgi-plan-phase { margin-bottom: 20px; border-radius: 8px; transition: background 0.12s, box-shadow 0.12s; }\r
.cgi-plan-phase.drop-target { background: rgba(14,165,233,0.10); box-shadow: 0 0 0 2px rgba(14,165,233,0.55); }\r
.cgi-plan-phase-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }\r
.cgi-plan-collapse {\r
  background: none; border: none; color: var(--cgi-text); opacity: 0.6;\r
  cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px; flex: none;\r
}\r
.cgi-plan-collapse:hover { opacity: 1; }\r
.cgi-plan-phase-title { font-weight: 600; font-size: 14px; cursor: pointer; }\r
.cgi-plan-phase-reorder { display: flex; flex-direction: column; flex: none; }\r
.cgi-plan-empty {\r
  font-size: 12px; opacity: 0.45; padding: 10px 8px; border: 1px dashed var(--cgi-border);\r
  border-radius: 6px; text-align: center;\r
}\r
.cgi-plan-phase-count { font-size: 12px; opacity: 0.55; }\r
.cgi-plan-progress { flex: 1; height: 6px; background: var(--cgi-border); border-radius: 3px; overflow: hidden; }\r
.cgi-plan-progress-bar { display: block; height: 100%; background: #10b981; }\r
.cgi-plan-list { display: flex; flex-direction: column; gap: 6px; }\r
.cgi-plan-card {\r
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;\r
  background: var(--cgi-surface); border: 1px solid var(--cgi-border);\r
  border-radius: 6px; cursor: default;\r
}\r
.cgi-plan-card.done { opacity: 0.5; }\r
.cgi-plan-card.done .cgi-plan-title { text-decoration: line-through; }\r
/* Open but already implemented (review/needs-testing) \u2014 green tint so it stands out as DONE, not to be reworked. */\r
.cgi-plan-card.in-review { background: rgba(34, 197, 94, 0.12); border-color: rgba(34, 197, 94, 0.55); }\r
.cgi-plan-card.in-review .cgi-plan-title { opacity: 0.7; }\r
.cgi-plan-review { font-size: 10px; background: #22c55e; color: #052e16; font-weight: 600; padding: 1px 6px; border-radius: 4px; flex: none; }\r
.cgi-plan-drag { cursor: grab; opacity: 0.4; user-select: none; }\r
.cgi-plan-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }\r
.cgi-plan-card-main {\r
  flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0;\r
  background: none; border: none; color: var(--cgi-text); cursor: pointer; text-align: left;\r
}\r
.cgi-plan-num { opacity: 0.5; font-size: 12px; flex: none; }\r
.cgi-plan-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\r
.cgi-plan-bug { font-size: 10px; background: #ef4444; color: #fff; padding: 1px 5px; border-radius: 4px; flex: none; }\r
.cgi-plan-reorder { display: flex; flex-direction: column; flex: none; }\r
.cgi-plan-arrow {\r
  background: none; border: none; color: var(--cgi-text); opacity: 0.5;\r
  cursor: pointer; font-size: 9px; line-height: 1; padding: 1px 4px;\r
}\r
.cgi-plan-arrow:disabled { opacity: 0.15; cursor: default; }\r
.cgi-plan-arrow:hover:not(:disabled) { opacity: 1; }\r
.cgi-plan-toolbar { display: flex; gap: 8px; margin-bottom: 12px; }\r
.cgi-plan-bootstrap { max-width: 460px; }\r
.cgi-plan-bootstrap-text {\r
  width: 100%; box-sizing: border-box; font-family: monospace; font-size: 13px;\r
  background: var(--cgi-bg); color: var(--cgi-text);\r
  border: 1px solid var(--cgi-border); border-radius: 6px; padding: 8px; margin: 8px 0;\r
}\r
.cgi-modal-actions { display: flex; gap: 10px; justify-content: flex-end; padding-top: 4px; }\r
\r
.cgi-plan-toggle {\r
  display: inline-flex; align-items: center; gap: 6px;\r
  font-size: 12px; opacity: 0.8; cursor: pointer; user-select: none; margin-left: 4px;\r
}\r
.cgi-plan-toggle input { cursor: pointer; margin: 0; }\r
`;var Ti=T(H()),xp="cgi-plugin-styles";if(typeof document<"u"&&!document.getElementById(xp)){let e=document.createElement("style");e.id=xp,e.textContent=yp,document.head.appendChild(e)}var Li=new WeakMap;function Q0(e,t){let n=Li.get(e);n||(n=(0,kp.createRoot)(e),Li.set(e,n)),n.render((0,Ti.jsx)(wp.default.StrictMode,{children:(0,Ti.jsx)(Qd,{api:t,children:(0,Ti.jsx)(vp,{})})}))}function K0(e){let t=Li.get(e);t&&(t.unmount(),Li.delete(e))}export{Q0 as mount,K0 as unmount};
/*! Bundled license information:

react/cjs/react.production.min.js:
  (**
   * @license React
   * react.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

scheduler/cjs/scheduler.production.min.js:
  (**
   * @license React
   * scheduler.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react-dom/cjs/react-dom.production.min.js:
  (**
   * @license React
   * react-dom.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-runtime.production.min.js:
  (**
   * @license React
   * react-jsx-runtime.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
