const root = document.getElementById('orders');
const availability = document.getElementById('availability');
const menuSearch = document.getElementById('menu-search');
const menuResults = document.getElementById('menu-results');
const orderSearch = document.getElementById('order-search');
const historyDate = document.getElementById('history-date');
let known = new Set();
let firstLoad = true;
let menuItems = [];
let unavailable = new Map();
let availabilityFilter = 'all';
let menuType = 'food';
let installPrompt = null;
let orderSearchTimer = null;
let orderView = 'current';
let activeOrderDay = '';
let orderRecords = new Map();
let historyAll = false;
let orderStatusFilter = 'all';
let operationsConfig = { printers: [], routes: [] };
let operationsMenu = [];
let operationsTab = 'kots';
let installedSystemPrinters = [];
let printBridgeState = 'checking';
let printBridgeConfigState = 'not-synced';
let assignmentPrinterId = '';
let assignmentMode = '';
const orderSearchPanel = document.querySelector('.order-search-panel');
const liveOrdersPanel = document.createElement('section');
liveOrdersPanel.id = 'live-orders-panel';
liveOrdersPanel.hidden = true;
if (orderSearchPanel && root) {
  orderSearchPanel.before(liveOrdersPanel);
  liveOrdersPanel.append(orderSearchPanel, root);
}
const orderStatusFilters = document.createElement('div');
orderStatusFilters.id = 'order-status-filters';
orderStatusFilters.setAttribute('aria-label', 'Filter live orders by status');
orderStatusFilters.innerHTML = [['all', 'All orders'], ['accepted', 'Accepted'], ['preparing', 'Preparing'], ['ready', 'Ready'], ['completed', 'Completed'], ['rejected', 'Rejected']].map(([value, label]) => `<button type="button" class="order-status-filter ${value === 'all' ? 'is-active' : ''} status-${value}" data-order-status-filter="${value}" aria-pressed="${value === 'all'}">${label}</button>`).join('');
orderSearchPanel?.after(orderStatusFilters);
const actionIcon = (name) => {
  const paths = {
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
    install: '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>',
    operations: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20.3h-3v-.08A1.7 1.7 0 0 0 10.66 18.66a1.7 1.7 0 0 0-1.88.34l-.06.06L6.6 16.94l.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.56-1.04H5.3v-3h.14A1.7 1.7 0 0 0 7 9.92a1.7 1.7 0 0 0-.34-1.88L6.6 7.98 8.72 5.86l.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.04-1.56V4.62h3v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06A1.7 1.7 0 0 0 19.4 9.92a1.7 1.7 0 0 0 1.56 1.04h.14v3h-.14A1.7 1.7 0 0 0 19.4 15Z"/>',
    cutlery: '<path d="M4 3v8M7 3v8M4 7h3M5.5 11v10M14 3v8M14 3c3 1 4.5 3.8 4.5 8H14M14 11v10"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/>'
  };
  return `<svg class="header-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
};
const liveOrdersToggle = document.createElement('button');
liveOrdersToggle.type = 'button';
liveOrdersToggle.id = 'live-orders-toggle';
liveOrdersToggle.className = 'live-orders-toggle';
liveOrdersToggle.setAttribute('aria-expanded', 'false');
liveOrdersToggle.innerHTML = `${actionIcon('receipt')}<span>Live orders</span><b id="live-orders-count">0</b>`;
document.querySelector('.header-actions')?.prepend(liveOrdersToggle);
const operationsPanel = document.createElement('section');
operationsPanel.id = 'operations-panel';
operationsPanel.hidden = true;
operationsPanel.innerHTML = '<div class="operations-head"><div><span class="eyebrow">Staff workspace</span><h2>Operations</h2><p>Review routed KOTs and configure kitchen, tandoori, bar, and bill printers.</p></div><button type="button" id="operations-close" class="quiet-button">Close</button></div><div id="operations-tabs" class="operation-launches"><button type="button" data-operations-tab="kots" class="operation-launch is-active"><span class="operation-icon kot-icon" aria-hidden="true">⌑</span><span><b>KOT queue</b><small>View and print live kitchen tickets</small></span><i aria-hidden="true">›</i></button><button type="button" data-operations-tab="printers" class="operation-launch"><span class="operation-icon printer-icon" aria-hidden="true">▣</span><span><b>Printer routing</b><small>Assign categories and items to printers</small></span><i aria-hidden="true">›</i></button></div><div id="operations-content"></div>';
availability.before(operationsPanel);
const operationsToggle = document.createElement('button');
operationsToggle.type = 'button';
operationsToggle.id = 'operations-toggle';
operationsToggle.className = 'operations-toggle';
operationsToggle.setAttribute('aria-expanded', 'false');
operationsToggle.innerHTML = `${actionIcon('operations')}<span>Operations</span>`;
document.querySelector('.header-actions')?.insertBefore(operationsToggle, document.getElementById('availability-toggle'));
const installButton = document.getElementById('install-shortcut');
const availabilityButton = document.getElementById('availability-toggle');
const alertsButton = document.getElementById('enable-notifications');
const refreshButton = document.querySelector('.header-actions button[onclick]');
if (installButton) installButton.innerHTML = `${actionIcon('install')}<span>Install shortcut</span>`;
if (availabilityButton) availabilityButton.innerHTML = `${actionIcon('cutlery')}<span>Menu availability</span>`;
if (alertsButton) alertsButton.innerHTML = `${actionIcon('bell')}<span>Enable alerts</span>`;
if (refreshButton) refreshButton.innerHTML = `${actionIcon('refresh')}<span>Refresh</span>`;
const liveOrdersStyles = document.createElement('style');
liveOrdersStyles.textContent = `.live-orders-toggle{display:inline-flex;align-items:center;gap:8px;color:#15335b;background:#fff;box-shadow:0 3px 11px rgba(7,20,45,.16)}.live-orders-toggle:hover,.live-orders-toggle.is-open{color:#fff;background:#168451}.live-dot{width:8px;height:8px;border-radius:50%;background:#e3342f;box-shadow:0 0 0 3px rgba(227,52,47,.14)}.live-orders-toggle.is-open .live-dot{background:#d9ffe9;box-shadow:0 0 0 3px rgba(217,255,233,.2)}.live-orders-toggle b{display:grid;min-width:19px;height:19px;place-items:center;padding:0 4px;border-radius:999px;color:#fff;background:#e3342f;font-size:10px}.live-orders-toggle.is-open b{color:#168451;background:#fff}#live-orders-panel{margin-top:20px}#live-orders-panel[hidden]{display:none}#live-orders-panel .order-search-panel{margin-top:0}#live-orders-panel main{padding-top:20px}#order-status-filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 28px 0}.order-status-filter{padding:8px 12px;border:1px solid transparent;border-radius:9px;font-size:11px}.order-status-filter.status-all{color:#fff;background:#263d68}.order-status-filter.status-accepted{color:#fff;background:#e3342f}.order-status-filter.status-preparing{color:#3d2a00;background:#f5a21a}.order-status-filter.status-ready{color:#fff;background:#168451}.order-status-filter.status-completed{color:#fff;background:#506078}.order-status-filter.status-rejected{color:#fff;background:#9b2634}.order-status-filter:not(.is-active){color:#68778e;background:#fff;border-color:#dce4ee;box-shadow:none}.order-status-filter:hover{transform:none;filter:none;border-color:currentColor}.order-status-filter.is-active{box-shadow:0 4px 11px rgba(31,48,80,.2)}@media(max-width:600px){.live-orders-toggle span:not(.live-dot){display:none}.live-orders-toggle{padding-inline:9px}#live-orders-panel{margin-top:14px}#order-status-filters{margin:10px 16px 0;gap:6px}.order-status-filter{padding:7px 9px;font-size:10px}}`;
document.head.appendChild(liveOrdersStyles);
const headerActionStyles = document.createElement('style');
headerActionStyles.textContent = `.header-actions button,.live-orders-toggle{display:inline-flex;align-items:center;justify-content:center;gap:8px}.header-action-icon{width:20px;height:20px;flex:0 0 20px}.live-orders-toggle{color:#fff;background:linear-gradient(135deg,#158951,#0f7545)}.live-orders-toggle:hover,.live-orders-toggle.is-open{color:#fff;background:linear-gradient(135deg,#0e7544,#0b603a)}.live-orders-toggle b{color:#d22731;background:#fff}.operations-toggle{color:#fff!important;background:linear-gradient(135deg,#3267bd,#24529d)!important;border:1px solid rgba(255,255,255,.72)!important}.operations-toggle:hover,.operations-toggle.is-open{background:linear-gradient(135deg,#2554a2,#173d7d)!important}.install-shortcut{color:#18365f!important;background:#fff!important}.availability-toggle{color:#132b4c!important;background:linear-gradient(135deg,#ffc548,#f9a92a)!important}.header-actions #enable-notifications,.header-actions button[onclick]{color:#fff!important;background:linear-gradient(135deg,#e93838,#c9242d)!important}@media(max-width:600px){.header-action-icon{width:18px;height:18px;flex-basis:18px}.header-actions button span{display:none}.header-actions button{padding-inline:10px!important}.live-orders-toggle span{display:none}}`;
document.head.appendChild(headerActionStyles);
const operationsStyles = document.createElement('style');
operationsStyles.textContent = `#operations-panel{margin:20px 28px 0;padding:24px;border:1px solid #dce4ee;border-radius:18px;background:#fff;box-shadow:0 14px 34px rgba(24,39,70,.09)}#operations-panel[hidden]{display:none}.operations-toggle{display:inline-flex;align-items:center;gap:7px;color:#fff;background:#53647e}.operations-toggle span{font-size:16px}.operations-toggle.is-open{background:#243b63}.operations-head{display:flex;justify-content:space-between;gap:16px}.operations-head h2{margin:4px 0;font-size:22px}.operations-head p{margin:0;color:#68778e}.operations-tabs{display:inline-flex;gap:4px;margin:20px 0 14px;padding:4px;border-radius:10px;background:#eef3f8}.operations-tabs button{padding:8px 12px;color:#627188;background:transparent;font-size:12px}.operations-tabs button.is-active{color:#fff;background:#263d68}.operations-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.operation-printer,.kot-ticket{padding:15px;border:1px solid #e1e8f0;border-radius:12px;background:#fff}.operation-printer-head,.kot-ticket-head{display:flex;justify-content:space-between;gap:10px;align-items:start}.operation-printer h3,.kot-ticket h3{margin:0;color:#23334e;font-size:15px}.printer-type{padding:4px 7px;border-radius:999px;color:#53647e;background:#eef3f8;font-size:10px;font-weight:900;text-transform:uppercase}.printer-type.kot{color:#087348;background:#e8f7ef}.operation-printer p{margin:8px 0 0;color:#6e7d91;font-size:12px}.operation-printer button{margin-top:12px;padding:7px 9px;color:#a52a39;background:#fff0f0;font-size:11px}.operations-form{display:grid;grid-template-columns:1.4fr .75fr auto;gap:9px;align-items:end;margin:13px 0}.operations-form label{display:grid;gap:4px;color:#5e6d83;font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}.operations-form input,.operations-form select{width:100%;padding:9px;border:1px solid #d4deea;border-radius:8px;color:#26344e;background:#fff;font:600 12px Manrope,sans-serif}.operations-form button{padding:10px 12px;background:#263d68;font-size:11px}.routing-list{display:grid;gap:8px;margin-top:13px}.route-row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:11px 12px;border:1px solid #e5ebf2;border-radius:9px;background:#f9fbfd;font-size:12px}.route-row b{color:#23334e}.route-row span{color:#718097}.route-row button{padding:6px 8px;color:#a52a39;background:#fff0f0;font-size:10px}.operations-save{margin-top:15px;background:#168451}.kot-ticket{border-left:4px solid #e3342f}.kot-ticket p{margin:6px 0;color:#718097;font-size:11px}.kot-items{margin:12px 0;padding:10px 0;border-block:1px solid #edf0f4}.kot-items div{padding:4px 0;color:#2f3e55;font-size:12px}.kot-items b{color:#c42b28}.kot-ticket button{padding:8px 10px;background:#263d68;font-size:11px}.operations-empty{padding:25px;color:#718097;border:1px dashed #d4deea;border-radius:12px;text-align:center}@media(max-width:600px){#operations-panel{margin:14px 16px 0;padding:16px}.operations-head p{font-size:12px}.operations-form{grid-template-columns:1fr}.operations-form button{width:100%}.operations-grid{grid-template-columns:1fr}}`;
document.head.appendChild(operationsStyles);
const operationsLauncherStyles = document.createElement('style');
operationsLauncherStyles.textContent = `.operation-launches{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:22px 0 18px}.operation-launch{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:center;padding:15px;border:1px solid #dfe7f1;border-radius:13px;color:#273852;background:#fff;text-align:left;box-shadow:0 3px 10px rgba(31,52,88,.035)}.operation-launch:hover{transform:translateY(-1px);filter:none;border-color:#aebfd4;box-shadow:0 8px 18px rgba(31,52,88,.1)}.operation-launch.is-active{border-color:#263d68;background:linear-gradient(135deg,#263d68,#35578d);color:#fff}.operation-icon{display:grid;width:44px;height:44px;place-items:center;border-radius:12px;color:#263d68;background:#e9f0fa;font-size:26px;font-weight:900}.operation-launch.is-active .operation-icon{color:#263d68;background:#fff}.operation-launch b,.operation-launch small{display:block}.operation-launch b{font-size:14px}.operation-launch small{margin-top:3px;color:#74839a;font-size:11px;font-weight:600;line-height:1.35}.operation-launch.is-active small{color:#d9e5f7}.operation-launch i{font-size:25px;font-style:normal;font-weight:400}@media(max-width:600px){.operation-launches{grid-template-columns:1fr}.operation-launch{padding:13px}}`;
document.head.appendChild(operationsLauncherStyles);
const operationsRoutingStyles = document.createElement('style');
operationsRoutingStyles.textContent = `.operations-section{padding:20px;border:1px solid #e2e9f1;border-radius:15px;background:linear-gradient(145deg,#fff,#fbfcfe)}.operations-section+.operations-section{margin-top:16px}.operations-section-head{display:flex;align-items:start;justify-content:space-between;gap:16px}.operations-section-head h3{margin:3px 0 5px;color:#1f2e47;font-size:18px}.operations-section-head p{max-width:660px;margin:0;color:#6a7890;font-size:12px;line-height:1.5}.operations-count{padding:7px 9px;border-radius:999px;color:#36547d;background:#edf3fb;font-size:10px;font-weight:900;white-space:nowrap}.operations-printer-form,.operations-route-form{display:grid;gap:10px;align-items:end;margin:18px 0}.operations-printer-form{grid-template-columns:minmax(180px,1.2fr) minmax(130px,.55fr) minmax(180px,.9fr) 90px auto}.operations-route-form{grid-template-columns:minmax(180px,.8fr) minmax(320px,1.4fr) auto}.operations-printer-form label,.operations-route-form label{display:grid;gap:5px;color:#55657b;font-size:10px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}.operations-printer-form input,.operations-printer-form select,.operations-route-form select{width:100%;min-height:42px;padding:10px 11px;border:1px solid #d5dfeb;border-radius:9px;color:#23334e;background:#fff;font:700 12px Manrope,sans-serif}.operations-printer-form input:focus,.operations-printer-form select:focus,.operations-route-form select:focus,.category-search:focus{outline:0;border-color:#2e67b1;box-shadow:0 0 0 3px rgba(46,103,177,.12)}.operations-printer-form button,.operations-route-form button{min-height:42px;padding:10px 13px;background:#263d68;font-size:11px;white-space:nowrap}.operations-printer-form button span{font-size:16px}.printer-grid{grid-template-columns:repeat(auto-fill,minmax(255px,1fr))}.operation-printer{min-height:146px;border-color:#dfe7f0;box-shadow:0 4px 12px rgba(30,51,83,.05)}.operation-printer-head{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:10px}.printer-card-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:10px;color:#087348;background:#e8f7ef;font-size:22px;font-weight:900}.printer-card-icon.bill{color:#315487;background:#eaf1ff}.operation-printer p{line-height:1.4}.printer-endpoint{margin:9px 0!important;padding:7px 9px;border-radius:8px;color:#56708f!important;background:#f2f6fb;font:800 10px ui-monospace,SFMono-Regular,Menlo,monospace!important}.printer-endpoint.is-pending{color:#9a6c20!important;background:#fff8e9}.routing-section{background:linear-gradient(145deg,#fffdf8,#fff)}.category-picker{border:1px solid #d5dfeb;border-radius:10px;background:#fff;padding:9px}.category-picker-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.category-picker-top b{color:#23334e;font-size:12px}.category-picker-top span{color:#64748b;font-size:10px;font-weight:800}.category-search{width:100%;min-height:37px;border:1px solid #d5dfeb;border-radius:8px;padding:8px 10px;font:700 12px Manrope,sans-serif}.category-checklist{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:7px;max-height:190px;overflow:auto;margin-top:9px;padding-right:2px}.category-choice{display:flex!important;align-items:center;gap:8px;padding:8px 9px;border:1px solid #e2e9f1;border-radius:8px;color:#33445f!important;background:#fbfcfe;font-size:11px!important;letter-spacing:0!important;text-transform:none!important;cursor:pointer}.category-choice:hover{border-color:#a9bdd8;background:#f1f6fd}.category-choice input{width:16px;height:16px;accent-color:#1e8b59}.category-choice.is-hidden{display:none!important}.route-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto}.route-icon{display:grid;width:26px;height:26px;place-items:center;border-radius:7px;color:#087348;background:#e8f7ef;font-size:16px}.route-row span{display:block;margin-top:3px}.operations-save-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:16px;padding:13px 15px;border:1px solid #cce8d8;border-radius:12px;background:#f3fbf6;color:#527260;font-size:12px;font-weight:700}.operations-save{margin:0!important;padding:10px 14px;white-space:nowrap}@media(max-width:900px){.operations-printer-form{grid-template-columns:1fr 1fr}.operations-printer-form button{width:100%}}@media(max-width:760px){.operations-printer-form,.operations-route-form{grid-template-columns:1fr}.operations-printer-form button,.operations-route-form button{width:100%}.operations-section{padding:16px}.operations-section-head{align-items:flex-start}.category-checklist{grid-template-columns:1fr}.operations-save-bar{align-items:stretch;flex-direction:column}.operations-save{width:100%}}`;
document.head.appendChild(operationsRoutingStyles);
const printerConnectionStyles = document.createElement('style');
printerConnectionStyles.textContent = `.operations-printer-form{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}.operations-printer-form button{align-self:end}`;
document.head.appendChild(printerConnectionStyles);
const operationsPolishStyles = document.createElement('style');
operationsPolishStyles.textContent = `#operations-panel{max-width:1680px;margin:24px auto;padding:30px}.operations-head h2{font-size:28px}.operations-head p{font-size:14px}.operation-launches{gap:14px;margin:24px 0}.operation-launch{min-height:84px;padding:18px}.operation-launch b{font-size:16px}.operation-launch small{font-size:12px}.operations-section{padding:24px}.operations-section-head h3{font-size:21px}.operations-section-head p{font-size:14px}.operations-count{padding:8px 11px;font-size:11px}.operations-printer-form{grid-template-columns:minmax(240px,1.3fr) minmax(175px,.7fr) minmax(300px,1.15fr) auto;gap:14px}.operations-printer-form label,.operations-route-form label{gap:7px;font-size:11px}.operations-printer-form input,.operations-printer-form select,.operations-route-form select{min-height:46px;padding:11px 13px;font-size:13px}.operations-printer-form button,.operations-route-form button{min-height:46px;padding:11px 16px;font-size:12px}.printer-grid{margin-top:20px}.operation-printer{min-height:156px;padding:18px}.operations-route-form{grid-template-columns:minmax(250px,.8fr) minmax(460px,1.55fr);gap:18px;align-items:start}.route-side-controls{display:grid;gap:13px}.route-side-controls button{width:100%;margin-top:3px}.category-picker{padding:15px;border-radius:12px;box-shadow:0 3px 12px rgba(29,51,83,.04)}.category-picker-top b{font-size:14px}.category-picker-top span{font-size:11px}.category-search{min-height:42px;font-size:13px}.category-checklist{grid-template-columns:repeat(3,minmax(150px,1fr));gap:9px;max-height:260px;padding:2px}.category-choice{min-height:42px;padding:10px 11px;font-size:12px!important}.category-choice input{width:18px;height:18px}.routing-list{margin-top:18px}.route-row{padding:13px 14px;font-size:13px}.operations-save-bar{margin-top:20px;padding:15px 17px;font-size:13px}@media(max-width:1100px){.operations-printer-form{grid-template-columns:1fr 1fr}.operations-route-form{grid-template-columns:1fr}.category-checklist{grid-template-columns:repeat(3,minmax(145px,1fr))}}@media(max-width:680px){#operations-panel{margin:14px 12px;padding:18px}.operations-head h2{font-size:24px}.operations-section{padding:17px}.operations-printer-form{grid-template-columns:1fr}.category-checklist{grid-template-columns:1fr}.operation-launches{grid-template-columns:1fr}.operations-save-bar{font-size:12px}}`;
document.head.appendChild(operationsPolishStyles);
const printerSetupStyles = document.createElement('style');
printerSetupStyles.textContent = `.operations-section:first-child{background:linear-gradient(145deg,#fff,#f8fbff)}.printer-setup-flow{display:flex;align-items:center;gap:12px;max-width:980px;margin:18px 0 20px;padding:12px 14px;border:1px solid #dbe8f7;border-radius:12px;background:#f5f9fe}.printer-setup-flow i{display:grid;width:34px;height:34px;place-items:center;flex:0 0 34px;border-radius:10px;color:#fff;background:#284778;font-size:17px;font-style:normal}.printer-setup-flow b,.printer-setup-flow span{display:block}.printer-setup-flow b{color:#243958;font-size:13px}.printer-setup-flow span{margin-top:2px;color:#6d7d95;font-size:12px;line-height:1.4}.operations-printer-form{max-width:1380px;padding:16px;border:1px solid #e0eaf5;border-radius:14px;background:#fff;box-shadow:0 5px 15px rgba(31,57,93,.035)}.operations-printer-form>*{min-width:0}.operations-printer-form input,.operations-printer-form select{box-sizing:border-box}.operations-printer-form button{min-width:132px}.printer-grid .operations-empty{grid-column:1/-1;min-height:116px;display:grid;place-items:center;margin-top:4px;border-style:dashed;background:#fbfdff;font-size:13px}.printer-grid{margin-top:16px}@media(max-width:760px){.printer-setup-flow{align-items:flex-start}.operations-printer-form{padding:14px}.operations-printer-form button{min-width:0}}`;
document.head.appendChild(printerSetupStyles);
const printBridgeSetupStyles = document.createElement('style');
printBridgeSetupStyles.textContent = `.printer-setup-flow{max-width:1380px}.bridge-setup{margin-left:auto;display:grid;gap:5px;max-width:510px;padding:10px 12px;border:1px solid #cfe2d8;border-radius:10px;background:#fff}.bridge-setup b{color:#087348}.bridge-setup span{font-size:11px}.bridge-setup code{padding:6px 8px;border-radius:6px;color:#243958;background:#edf3f8;font:700 10px ui-monospace,monospace;word-break:break-word}.bridge-setup button{justify-self:start;padding:6px 9px;color:#fff;background:#284778;font-size:10px}@media(max-width:900px){.printer-setup-flow{align-items:flex-start;flex-wrap:wrap}.bridge-setup{width:100%;max-width:none;margin-left:0}}`;
document.head.appendChild(printBridgeSetupStyles);
const managePrintersStyles = document.createElement('style');
managePrintersStyles.textContent = `.manage-printers,.printer-assignment{padding:24px;border:1px solid #dfe7f1;border-radius:16px;background:#fff}.manage-printers-head{display:flex;justify-content:space-between;gap:18px;align-items:start}.manage-printers h3,.printer-assignment h3{margin:4px 0;color:#1e3150;font-size:23px}.manage-printers p,.printer-assignment p{margin:0;color:#687a91}.bridge-status{max-width:370px;padding:9px 12px;border-radius:9px;color:#8a5b13;background:#fff5dc;font-size:12px;font-weight:700}.bridge-status.online{color:#087348;background:#e8f7ef}.add-system-printer{display:flex;gap:10px;margin:22px 0}.add-system-printer select{flex:1;min-height:44px;padding:10px;border:1px solid #cfdceb;border-radius:9px}.add-system-printer button,.printer-table-row button{padding:10px 14px;background:#246ce0;color:#fff}.printer-table{border:1px solid #dfe6ee;border-radius:12px;overflow:hidden}.printer-table-head,.printer-table-row{display:grid;grid-template-columns:1.5fr .8fr 1fr auto;gap:16px;align-items:center;padding:16px 18px}.printer-table-head{color:#526680;background:#eef2f6;font-size:11px;font-weight:900;text-transform:uppercase}.printer-table-row+.printer-table-row{border-top:1px solid #e1e7ee}.printer-table-row b,.printer-table-row small{display:block}.printer-table-row b{color:#1d2f4a}.printer-table-row small{margin-top:4px;color:#76869a;font-size:11px}.assignment-tag{display:inline-block;margin:2px;padding:5px 9px;border-radius:999px;color:#087348;background:#e8f7ef;font-size:11px;font-style:normal;font-weight:800}.printer-table-row .remove-printer{margin-left:6px;color:#a52a39;background:#fff0f0}.assignment-back{margin-bottom:17px;color:#27436b;background:#eef4fa}.assignment-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;max-width:720px;margin-top:24px}.assignment-choices button{display:grid;gap:6px;padding:22px;text-align:left;color:#1e3150;background:#fff;border:1px solid #d6e0ea}.assignment-choices button:hover{border-color:#246ce0;background:#f4f8ff}.assignment-choices b{font-size:16px}.assignment-choices span{color:#718198}.assignment-category-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:22px}.assignment-category-grid label{display:flex;align-items:center;gap:9px;padding:12px;border:1px solid #dce5ee;border-radius:9px;color:#263b59;font-size:12px;font-weight:700}.assignment-category-grid input{width:17px;height:17px;accent-color:#168451}.assignment-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.assignment-actions button{padding:11px 15px;background:#eef3f8;color:#304562}.assignment-actions .operations-save{color:#fff;background:#168451}@media(max-width:760px){.manage-printers-head{display:grid}.printer-table-head{display:none}.printer-table-row{grid-template-columns:1fr;gap:8px}.add-system-printer{display:grid}.assignment-choices,.assignment-category-grid{grid-template-columns:1fr}}`;
document.head.appendChild(managePrintersStyles);
const printerRoutingSummaryStyles = document.createElement('style');
printerRoutingSummaryStyles.textContent = `.printer-table-row .routing-summary{margin-top:9px;padding:7px 9px;border-radius:7px;color:#355577;background:#f1f6fb;line-height:1.5}.printer-table-row .routing-summary b{display:inline;color:#23436c;font-size:11px}`;
document.head.appendChild(printerRoutingSummaryStyles);

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[char]);
const money = (value) => `₹${Number(value || 0).toFixed(0)}`;
const tomorrowLocal = () => { const date = new Date(Date.now() + 86400000); date.setSeconds(0, 0); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const toPushKey = (value) => { const padding = '='.repeat((4 - value.length % 4) % 4); const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (character) => character.charCodeAt(0)); };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/orders-sw.js?v=6');
document.getElementById('enable-notifications')?.addEventListener('click', async () => {
  const button = document.getElementById('enable-notifications');
  const notificationApi = window.Notification;
  try {
    if (!notificationApi || !('PushManager' in window) || !('serviceWorker' in navigator)) throw new Error('Push alerts need the installed Orders shortcut. Use Install shortcut first.');
    button.disabled = true;
    button.innerHTML = `${actionIcon('bell')}<span>Enabling…</span>`;
    const permission = await notificationApi.requestPermission();
    if (permission !== 'granted') throw new Error('Alerts were not allowed. Enable notifications for RL Orders in this device’s settings.');
    const keyResponse = await fetch('/api/orders/push-key', { cache: 'no-store' });
    const keyBody = await keyResponse.json();
    if (!keyResponse.ok) throw new Error(keyBody.error || 'Push alerts are not configured yet.');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toPushKey(keyBody.publicKey) });
    const saveResponse = await fetch('/api/orders/push-subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription }) });
    const saveBody = await saveResponse.json();
    if (!saveResponse.ok) throw new Error(saveBody.error || 'Unable to enable push alerts.');
    button.innerHTML = `${actionIcon('bell')}<span>Alerts enabled</span>`;
  } catch (error) {
    button.innerHTML = `${actionIcon('bell')}<span>Enable alerts</span>`;
    const dialog = document.getElementById('shortcut-dialog');
    document.getElementById('shortcut-message').textContent = error.message;
    document.getElementById('shortcut-steps').innerHTML = '<li>Install the RL Orders shortcut on this device.</li><li>Open it once and tap Enable alerts.</li><li>Allow notifications when your device asks.</li>';
    if (typeof dialog?.showModal === 'function') dialog.showModal(); else alert(error.message);
  } finally { button.disabled = false; }
});

async function loadOrders() {
  try {
    let query = String(orderSearch?.value || '').replace(/\D/g, '').slice(0, 16);
    const date = historyAll ? '' : String(historyDate?.value || '');
    const response = await fetch(`/api/orders?search=${encodeURIComponent(query)}&history=${orderView === 'history' ? '1' : '0'}&date=${encodeURIComponent(date)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to refresh orders.');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Unable to read orders. Please refresh.');
    orderRecords = new Map(rows.map((order) => [order.id, order]));
    const orderDay = response.headers.get('X-Orders-Day') || '';
    const sessionOpen = response.headers.get('X-Orders-Session') !== 'closed';
    if (activeOrderDay && orderDay && activeOrderDay !== orderDay && orderSearch) { orderSearch.value = ''; query = ''; }
    activeOrderDay = orderDay || activeOrderDay;
    const ids = new Set(rows.map((order) => order.id));
    const notificationApi = window.Notification;
    if (orderView === 'current' && !firstLoad && notificationApi && notificationApi.permission === 'granted') rows.filter((order) => !known.has(order.id) && order.status === 'new').forEach((order) => new notificationApi('New Direct Order', { body: `${order.customer_name || 'Guest'} · ${order.customer_phone}`, icon: '/images/red-lantern-logo-600.webp' }));
    if (orderView === 'current') known = ids;
    const liveCount = document.getElementById('live-orders-count');
    if (liveCount && orderView === 'current') liveCount.textContent = String(rows.length);
    firstLoad = false;
    const visibleRows = orderStatusFilter === 'all' ? rows : rows.filter((order) => order.status === orderStatusFilter);
    const emptyMessage = query ? 'No orders match that number.' : orderView === 'current' && !sessionOpen ? 'The restaurant is closed. Today\'s orders are safely available in Order history.' : 'No direct orders yet.';
    const filteredEmpty = orderStatusFilter !== 'all' ? `No ${orderStatusFilter} orders in this view.` : emptyMessage;
    root.innerHTML = visibleRows.map(renderOrder).join('') || `<div class="empty-state">${filteredEmpty}</div>`;
    const clearButton = document.getElementById('clear-order-search');
    const searchStatus = document.getElementById('order-search-status');
    if (clearButton) clearButton.hidden = !query;
    if (searchStatus) searchStatus.textContent = query ? `${visibleRows.length} matching order${visibleRows.length === 1 ? '' : 's'}` : orderView === 'history' ? `History · ${date || 'choose a date'}` : sessionOpen ? `${visibleRows.length} ${orderStatusFilter === 'all' ? 'current' : orderStatusFilter} order${visibleRows.length === 1 ? '' : 's'}` : 'Session closed · orders archived';
  } catch (error) {
    root.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
  }
}

function renderOrder(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemCount = items.reduce((count, item) => count + Number(item.quantity || 0), 0);
  const fallbackTotal = items.reduce((sum, item) => sum + Number(item.quantity || 0) * (Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0)), 0);
  const storedTotal = Number(order.total);
  const total = storedTotal > 0 ? storedTotal : fallbackTotal;
  const age = Math.max(0, Math.floor((Date.now() - new Date(order.created_at)) / 60000));
  const placedAt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(order.created_at));
  const orderCount = Number(order.customer_order_count || 1);
  const history = order.customer_last_order_at ? `Last ordered: ${new Date(order.customer_last_order_at).toLocaleDateString('en-IN')}` : 'First order';
  const dailyNumber = Number(order.daily_order_number);
  const orderNumber = Number.isFinite(dailyNumber) && dailyNumber > 0 ? String(dailyNumber).padStart(2, '0') : '—';
  const controls = ['cancelled', 'completed', 'rejected'].includes(order.status) ? '' : ['accepted', 'preparing', 'ready', 'completed', 'rejected'].map((status) => `<button onclick="setStatus('${esc(order.id)}','${status}')">${status}</button>`).join('');
  const canModify = age < 10 && ['new', 'accepted', 'preparing'].includes(order.status);
  return `<article class="order" data-order-id="${esc(order.id)}"><div class="order-heading"><span class="daily-order-number">Order #${orderNumber}</span><span class="order-status">${esc(order.status)}</span></div><div class="order-reference">Ref ${esc(order.id)}</div><div class="order-time">${age} min ago</div><div class="placed-at"><span>Placed</span>${esc(placedAt)} <small>Goa time</small></div><div class="meta">${esc(order.customer_name || 'Guest')} · <b class="phone">${esc(order.customer_phone)}</b></div><div class="customer-trust"><b>${orderCount === 1 ? 'New customer' : `${orderCount} orders from this number`}</b><span>${history}</span></div>${order.special_request ? `<div class="request">Special request: ${esc(order.special_request)}</div>` : ''}${order.cancellation_reason ? `<div class="request">Cancelled: ${esc(order.cancellation_reason)}</div>` : ''}<div class="items">${items.map((item) => `<div><b>${Number(item.quantity || 0)}×</b> ${esc(item.name)} ${item.portion ? `(${esc(item.portion)})` : ''}${item.style ? ` — ${esc(item.style)} (+₹10)` : ''}</div>`).join('')}</div><div class="totals"><b>${itemCount} item${itemCount === 1 ? '' : 's'}</b><strong>Total ${money(total)}</strong></div><div class="actions">${controls}${canModify ? `<button class="modify-order" data-modify-order="${esc(order.id)}">Modify order</button>` : ''}<button class="print" onclick="printOrder('${esc(order.id)}')">Print</button></div></article>`;
}

async function setStatus(id, status) {
  await fetch(`/api/orders/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  loadOrders();
}

function openModifyOrder(id) {
  const order = orderRecords.get(id);
  if (!order || !Array.isArray(order.items)) return;
  let dialog = document.getElementById('modify-order-dialog');
  if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'modify-order-dialog'; dialog.className = 'modify-order-dialog'; document.body.appendChild(dialog); }
  const rows = order.items.map((item, index) => `<label><span>${esc(item.name)}${item.portion ? ` · ${esc(item.portion)}` : ''}</span><input type="number" min="0" max="20" value="${Number(item.quantity || 0)}" data-modify-quantity="${index}"></label>`).join('');
  dialog.innerHTML = `<button class="modify-close" aria-label="Close">×</button><span class="eyebrow">Staff only · first 10 minutes</span><h2>Modify order #${esc(String(order.daily_order_number || '').padStart(2, '0'))}</h2><p>Update quantities or set an item to 0 to remove it. Prices stay controlled by Admin.</p><div class="modify-items">${rows}</div><button class="modify-save">Save changes</button>`;
  dialog.showModal();
  dialog.querySelector('.modify-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('.modify-save').addEventListener('click', async () => { const button = dialog.querySelector('.modify-save'); button.disabled = true; try { const quantities = [...dialog.querySelectorAll('[data-modify-quantity]')].map((input) => Number(input.value || 0)); const response = await fetch(`/api/orders/${encodeURIComponent(id)}/items`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ quantities }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Unable to modify this order.'); dialog.close(); loadOrders(); } catch (error) { button.disabled = false; window.alert(error.message); } });
}

async function printOrder(id) {
  const popup = window.open('', 'red-lantern-receipt', 'popup=yes,width=420,height=720');
  if (!popup) { alert('Please allow pop-ups to print the receipt.'); return; }
  try {
    popup.document.write('<!doctype html><title>Preparing receipt…</title>');
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}/print`, { cache: 'no-store' });
    const order = await response.json();
    if (!response.ok) throw new Error(order.error || 'Unable to prepare this receipt.');
    const items = Array.isArray(order.items) ? order.items : [];
    const itemPrice = (item) => Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0);
    const quantity = items.reduce((total, item) => total + Number(item.quantity || 0), 0);
    const calculatedTotal = items.reduce((total, item) => total + Number(item.quantity || 0) * itemPrice(item), 0);
    const grandTotal = Number(order.total) > 0 ? Number(order.total) : calculatedTotal;
    const dailyNumber = Number(order.daily_order_number);
    const token = Number.isFinite(dailyNumber) && dailyNumber > 0 ? String(dailyNumber).padStart(2, '0') : '—';
    const placedAt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(order.created_at));
    const orderType = order.fulfillment_type || (order.mode === 'table' ? 'Pick Up' : 'Delivery');
    const itemRows = items.map((item) => {
      const label = `${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` — ${item.style}` : ''}`;
      const qty = Number(item.quantity || 0);
      return `<tr><td class="item-name">${esc(label)}</td><td>${qty}</td><td>${money(itemPrice(item))}</td><td>${money(qty * itemPrice(item))}</td></tr>`;
    }).join('');
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Red Lantern · Token ${esc(token)}</title><style>@page{size:80mm auto;margin:4mm}*{box-sizing:border-box}body{width:72mm;margin:0;color:#111;font:12px Arial,sans-serif}.center{text-align:center}.restaurant{font-size:18px;font-weight:800;letter-spacing:.2px}.sub{margin:3px 0;color:#333}.rule{border:0;border-top:1px dashed #222;margin:10px 0}.wallet{padding:7px 0;font-weight:700}.details{line-height:1.55}.details b{display:inline-block;min-width:68px}table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px}th{padding:5px 0;border-bottom:1px solid #222;text-align:right;font-size:10px}th:first-child{text-align:left}td{padding:5px 0;vertical-align:top;text-align:right;border-bottom:1px dotted #bbb}.item-name{text-align:left;padding-right:5px}.totals{display:flex;justify-content:space-between;font-size:13px;font-weight:700}.grand{display:flex;justify-content:space-between;margin-top:6px;font-size:16px;font-weight:800}.note{margin-top:8px;font-size:10px;line-height:1.4}.footer{margin-top:14px;font-size:10px;text-align:center;color:#333}@media print{body{width:72mm}}</style></head><body><div class="center"><div class="restaurant">RED LANTERN RESTAURANT</div><div class="sub">Restaurant Mobile Number: 9922853605</div><div class="sub">Direct Order Receipt</div></div><hr class="rule"><div class="wallet">Wallet Points: ${Number(order.loyalty_points || 0)}</div><div class="details"><div><b>Name:</b> ${esc(order.customer_name || 'Not provided')}</div><div><b>Mobile:</b> ${esc(order.customer_phone || '—')}</div><div><b>Type:</b> ${esc(orderType)}</div><div><b>Token No:</b> ${esc(token)}</div><div><b>Placed:</b> ${esc(placedAt)}</div></div>${order.special_request ? `<div class="note"><b>Special request:</b> ${esc(order.special_request)}</div>` : ''}<hr class="rule"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead><tbody>${itemRows}</tbody></table><hr class="rule"><div class="totals"><span>Total Qty: ${quantity}</span><span>Items: ${items.length}</span></div><div class="grand"><span>GRAND TOTAL</span><span>${money(grandTotal)}</span></div><hr class="rule"><div class="footer">Thank you for ordering with us!<br>Red Lantern Restaurant</div><script>window.onload=()=>setTimeout(()=>window.print(),150);window.onafterprint=()=>window.close();<\/script></body></html>`);
    popup.document.close();
  } catch (error) {
    popup.close();
    alert(error.message || 'Unable to prepare this receipt.');
  }
}

const operationId = () => `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
const routePrinter = (item) => {
  const printers = new Map(operationsConfig.printers.map((printer) => [printer.id, printer]));
  const routes = operationsConfig.routes.filter((route) => printers.get(route.printerId)?.type === 'kot');
  const route = routes.find((entry) => entry.category === item.category && entry.itemName === item.name) || routes.find((entry) => entry.category === item.category && !entry.itemName);
  return route ? printers.get(route.printerId) : null;
};
const selectedRouteCategories = () => [...document.querySelectorAll('.operation-route-category-check:checked')].map((input) => input.value);
function refreshRouteItemOptions() {
  const itemSelect = document.getElementById('operation-route-item');
  if (!itemSelect) return;
  const selected = selectedRouteCategories();
  if (selected.length !== 1) {
    itemSelect.disabled = true;
    itemSelect.innerHTML = `<option value="">${selected.length ? 'Choose one category for an item override' : 'Select a category first'}</option>`;
    return;
  }
  const category = selected[0];
  itemSelect.disabled = false;
  itemSelect.innerHTML = `<option value="">All selected categories</option>${operationsMenu.filter((item) => item.category === category).sort((a,b)=>a.name.localeCompare(b.name)).map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('')}`;
}
function assignedKinds(printer) {
  const kinds = [];
  if (printer.type === 'bill') kinds.push('Bill');
  if (operationsConfig.routes.some((route) => route.printerId === printer.id)) kinds.push('KOT');
  return kinds;
}
function renderPrinterManagement() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  const printer = operationsConfig.printers.find((item) => item.id === assignmentPrinterId);
  const categories = [...new Set(operationsMenu.map((item) => item.category).filter(Boolean))].sort();
  if (printer && assignmentMode) {
    const selected = new Set(operationsConfig.routes.filter((route) => route.printerId === printer.id && !route.itemName).map((route) => route.category));
    content.innerHTML = assignmentMode === 'choose'
      ? `<section class="printer-assignment"><button type="button" class="assignment-back" data-assignment-back>‹ Back</button><h3>Assign printer · ${esc(printer.name)}</h3><p>Choose how this installed printer will be used.</p><div class="assignment-choices"><button type="button" data-assign-bill><b>▤ Assign to Bill</b><span>Customer receipts and bills</span></button><button type="button" data-assign-kot><b>⌑ Assign to KOT</b><span>Kitchen order tickets</span></button></div></section>`
      : `<section class="printer-assignment"><button type="button" class="assignment-back" data-assignment-back>‹ Back</button><h3>Assign KOT categories · ${esc(printer.name)}</h3><p>Select every category this printer should receive.</p><div class="assignment-category-grid">${categories.map((category) => `<label><input type="checkbox" data-assignment-category value="${esc(category)}" ${selected.has(category) ? 'checked' : ''}><span>${esc(category)}</span></label>`).join('')}</div><div class="assignment-actions"><button type="button" data-assignment-back>Cancel</button><button type="button" class="operations-save" data-save-kot-assignment>Save KOT assignment</button></div></section>`;
    return;
  }
  const bridgeText = printBridgeState === 'available' ? 'Print Bridge is running — installed printers are available.' : 'Print Bridge is not detected on this computer.';
  content.innerHTML = `<section class="manage-printers"><div class="manage-printers-head"><div><span class="eyebrow">Printer setup</span><h3>Manage printers</h3><p>Connect installed system printers, then assign each one to bills or KOT categories.</p></div><span class="bridge-status ${printBridgeState === 'available' ? 'online' : ''}">${bridgeText}</span></div><div class="add-system-printer"><select id="quick-system-printer"><option value="">Choose installed printer</option>${installedSystemPrinters.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select><button type="button" id="quick-add-printer">＋ Add printer</button></div><div class="printer-table"><div class="printer-table-head"><span>Printer name</span><span>Printer type</span><span>Assigned for</span><span>Actions</span></div>${operationsConfig.printers.map((item) => { const kinds=assignedKinds(item); const routes=operationsConfig.routes.filter((route)=>route.printerId===item.id); const categories=[...new Set(routes.filter((route)=>!route.itemName).map((route)=>route.category))]; const overrides=routes.filter((route)=>route.itemName).map((route)=>`${route.category} · ${route.itemName}`); const routingSummary=categories.length || overrides.length ? `<small class="routing-summary"><b>Receives:</b> ${categories.length ? `Categories — ${esc(categories.join(', '))}` : ''}${categories.length && overrides.length ? '<br>' : ''}${overrides.length ? `Items — ${esc(overrides.join(', '))}` : ''}</small>` : ''; return `<div class="printer-table-row"><div><b>${esc(item.name)}</b><small>${esc(item.deviceName || 'System printer not assigned')}</small>${routingSummary}</div><span>${item.type === 'bill' ? 'Bill printer' : 'General'}</span><div>${kinds.length ? kinds.map((kind) => `<em class="assignment-tag">${kind}</em>`).join(' ') : '<small>Not assigned</small>'}</div><div><button type="button" data-assign-printer="${esc(item.id)}">Assign</button><button type="button" class="remove-printer" data-delete-printer="${esc(item.id)}">Remove</button></div></div>`; }).join('') || '<div class="operations-empty">Add an installed printer to begin.</div>'}</div></section>`;
}
function renderOperations() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  if (operationsTab === 'kots') {
    const activeOrders = [...orderRecords.values()].filter((order) => !['completed','rejected','cancelled'].includes(order.status));
    const tickets = new Map();
    activeOrders.forEach((order) => (Array.isArray(order.items) ? order.items : []).forEach((item) => {
      const printer = routePrinter(item);
      const key = `${order.id}::${printer?.id || 'unassigned'}`;
      if (!tickets.has(key)) tickets.set(key, { order, printer, items: [] });
      tickets.get(key).items.push(item);
    }));
    content.innerHTML = `<p class="help-text">KOTs are grouped by the printer rules below. Items without a matching rule stay clearly marked as <strong>Unassigned</strong>.</p><div class="operations-grid">${[...tickets.values()].map((ticket) => { const number=String(ticket.order.daily_order_number||'—').padStart(2,'0'); return `<article class="kot-ticket"><div class="kot-ticket-head"><div><h3>Order #${esc(number)}</h3><p>${esc(ticket.order.customer_name || 'Guest')} · ${esc(ticket.order.customer_phone)}</p></div><span class="printer-type kot">${esc(ticket.printer?.name || 'Unassigned')}</span></div><div class="kot-items">${ticket.items.map((item) => `<div><b>${Number(item.quantity||0)}×</b> ${esc(item.name)}${item.portion?` · ${esc(item.portion)}`:''}${item.style?` · ${esc(item.style)}`:''}</div>`).join('')}</div><button type="button" data-print-kot="${esc(ticket.order.id)}" data-printer-id="${esc(ticket.printer?.id || '')}">Print KOT</button></article>`; }).join('') || '<div class="operations-empty">No live KOTs right now. New and active orders will appear here.</div>'}</div>`;
  } else {
    renderPrinterManagement();
    return;
    const kotPrinters = operationsConfig.printers.filter((printer) => printer.type === 'kot');
    const categories = [...new Set(operationsMenu.map((item) => item.category).filter(Boolean))].sort();
    const printerOptions = kotPrinters.map((printer) => `<option value="${esc(printer.id)}">${esc(printer.name)}</option>`).join('');
    content.innerHTML = `<section class="operations-section"><div class="operations-section-head"><div><span class="eyebrow">Step 1</span><h3>Printers</h3><p>Create every printer used by your restaurant. You can add as many KOT and Bill printers as needed.</p></div><span class="operations-count">${operationsConfig.printers.length} configured</span></div><div class="operations-printer-form"><label>Printer name<input id="operation-printer-name" maxlength="60" placeholder="e.g. Tandoori Printer"></label><label>Printer type<select id="operation-printer-type"><option value="kot">KOT printer</option><option value="bill">Bill printer</option></select></label><button type="button" id="operation-add-printer"><span aria-hidden="true">＋</span> Add printer</button></div><div class="operations-grid printer-grid">${operationsConfig.printers.map((printer) => `<article class="operation-printer"><div class="operation-printer-head"><span class="printer-card-icon ${esc(printer.type)}" aria-hidden="true">${printer.type === 'bill' ? '▣' : '⌑'}</span><div><h3>${esc(printer.name)}</h3><p>${printer.type === 'bill' ? 'Counter / bill receipt printer' : 'Kitchen order ticket printer'}</p></div><span class="printer-type ${esc(printer.type)}">${esc(printer.type)}</span></div><button type="button" data-delete-printer="${esc(printer.id)}">Remove</button></article>`).join('') || '<div class="operations-empty">Add your first printer to start routing KOTs.</div>'}</div></section><section class="operations-section routing-section"><div class="operations-section-head"><div><span class="eyebrow">Step 2</span><h3>KOT routing</h3><p>Select every category this printer should receive. Use the item override only for a single-item exception.</p></div><span class="operations-count">${operationsConfig.routes.length} rules</span></div><div class="operations-route-form"><label>Send to printer<select id="operation-route-printer"><option value="">Choose KOT printer</option>${printerOptions}</select></label><div class="category-picker"><div class="category-picker-top"><b>Categories for this printer</b><span id="route-category-count">0 selected</span></div><input id="operation-route-category-search" class="category-search" type="search" placeholder="Search categories"><div id="operation-route-categories" class="category-checklist">${categories.map((category) => `<label class="category-choice"><input class="operation-route-category-check" type="checkbox" value="${esc(category)}"><span>${esc(category)}</span></label>`).join('')}</div></div><label>Specific item <select id="operation-route-item" disabled><option value="">Select one category first</option></select></label><button type="button" id="operation-add-route">Add selected routes</button></div><div class="routing-list">${operationsConfig.routes.map((route) => { const printer=operationsConfig.printers.find((item)=>item.id===route.printerId); return `<div class="route-row"><span class="route-icon" aria-hidden="true">⌑</span><div><b>${esc(route.category)}${route.itemName ? ` · ${esc(route.itemName)}` : ' · all items'}</b><span>Print on ${esc(printer?.name || 'Missing printer')}</span></div><button type="button" data-delete-route="${esc(route.id)}">Remove</button></div>`; }).join('') || '<div class="operations-empty">No KOT routes yet. Select one or more categories above to set up routing.</div>'}</div></section><div class="operations-save-bar"><span>Changes are saved only when you confirm.</span><button type="button" id="operations-save" class="operations-save">Save printer configuration</button></div>`;
    const printerForm = document.querySelector('.operations-printer-form');
    const addPrinterButton = document.getElementById('operation-add-printer');
    if (printerForm && addPrinterButton) {
      const setupFlow = document.createElement('div');
      setupFlow.className = 'printer-setup-flow';
      const isMac = /macintosh|mac os x/i.test(navigator.userAgent);
      const bridgeCommand = isMac ? 'bash ./install-print-bridge-macos.sh' : 'powershell -ExecutionPolicy Bypass -File .\\install-print-bridge-windows.ps1';
      const bridgeLabel = printBridgeState === 'available' ? 'Print Bridge is running on this computer.' : 'Print Bridge is not running on this computer.';
      setupFlow.innerHTML = `<i aria-hidden="true">▣</i><div><b>Add a restaurant printer</b><span>Give it a clear role, select its installed system printer, then assign its menu categories in Step 2.</span></div><div class="bridge-setup"><b>${bridgeLabel}</b><span>One-time setup on every computer that has printers. Open Terminal / PowerShell in the website folder, then run:</span><code>${esc(bridgeCommand)}</code><button type="button" id="copy-print-bridge-command" data-command="${esc(bridgeCommand)}">Copy setup command</button></div>`;
      printerForm.before(setupFlow);
      const deviceField = document.createElement('label');
      const bridgeMessage = printBridgeState === 'checking' ? 'Detecting installed printers…' : printBridgeState === 'offline' ? 'Print Bridge not detected' : 'Choose installed printer';
      deviceField.innerHTML = `Installed system printer<select id="operation-printer-device"><option value="">${bridgeMessage}</option>${installedSystemPrinters.map((printer) => `<option value="${esc(printer.id)}">${esc(printer.name)}</option>`).join('')}</select>`;
      printerForm.insertBefore(deviceField, addPrinterButton);
    }
    document.querySelectorAll('.operation-printer').forEach((card, index) => {
      const printer = operationsConfig.printers[index];
      if (!printer) return;
      const endpoint = document.createElement('p');
      endpoint.className = `printer-endpoint${printer.deviceName ? '' : ' is-pending'}`;
      endpoint.textContent = printer.deviceName ? `System printer · ${printer.deviceName}` : 'System printer to be assigned during installation';
      card.querySelector('.operation-printer-head')?.after(endpoint);
    });
    const routeForm = document.querySelector('.operations-route-form');
    const categoryPicker = routeForm?.querySelector('.category-picker');
    const printerControl = document.getElementById('operation-route-printer')?.closest('label');
    const itemControl = document.getElementById('operation-route-item')?.closest('label');
    const addRouteButton = document.getElementById('operation-add-route');
    if (routeForm && categoryPicker && printerControl && itemControl && addRouteButton) {
      const controls = document.createElement('div');
      controls.className = 'route-side-controls';
      controls.append(printerControl, itemControl, addRouteButton);
      routeForm.prepend(controls);
    }
    const saveStatus = document.querySelector('.operations-save-bar span');
    if (saveStatus) {
      saveStatus.textContent = printBridgeConfigState === 'synced'
        ? 'Saved securely in the cloud and on this restaurant computer.'
        : printBridgeConfigState === 'waiting-for-bridge'
          ? 'Saved securely in the cloud. The local offline copy will sync when Print Bridge is running.'
          : 'Save once. The local Print Bridge will retain this routing for offline use.';
    }
  }
}
async function loadOperations() {
  const response = await fetch('/api/orders/operations', { cache:'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to load Operations.');
  operationsConfig = data.config || { printers:[], routes:[] };
  operationsMenu = Array.isArray(data.menu) ? data.menu : [];
  renderOperations();
}
async function discoverSystemPrinters() {
  printBridgeState = 'checking';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    const response = await fetch('http://127.0.0.1:9124/v1/printers', { cache:'no-store', signal:controller.signal });
    clearTimeout(timer);
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.printers)) throw new Error('Print Bridge did not return installed printers.');
    installedSystemPrinters = body.printers.map((printer) => ({ id:String(printer.id || printer.name || ''), name:String(printer.name || '') })).filter((printer) => printer.id && printer.name);
    printBridgeState = 'available';
  } catch (_) {
    installedSystemPrinters = [];
    printBridgeState = 'offline';
  }
}
async function syncOperationsToPrintBridge(config) {
  if (printBridgeState !== 'available') { printBridgeConfigState = 'waiting-for-bridge'; return false; }
  try {
    const response = await fetch('http://127.0.0.1:9124/v1/config', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ config }) });
    if (!response.ok) throw new Error('Bridge sync failed.');
    printBridgeConfigState = 'synced';
    return true;
  } catch (_) {
    printBridgeConfigState = 'waiting-for-bridge';
    return false;
  }
}
async function saveOperations() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch('/api/orders/operations', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ config:operationsConfig }), signal:controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Saving took too long. Check the internet connection, then try again.');
    throw new Error('Unable to reach the server. Check the internet connection, then try again.');
  } finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to save printer configuration.');
  operationsConfig = data.config;
  await syncOperationsToPrintBridge(operationsConfig);
  renderOperations();
}
function addSelectedRoutes() {
  const printerId=String(document.getElementById('operation-route-printer')?.value||'');
  const categories=selectedRouteCategories();
  const itemName=String(document.getElementById('operation-route-item')?.value||'');
  if (!categories.length) return false;
  if (!printerId) throw new Error('Choose a KOT printer before saving these categories.');
  if (itemName && categories.length !== 1) throw new Error('Choose exactly one category to route a specific item.');
  categories.forEach((category) => {
    const duplicate=operationsConfig.routes.some((route)=>route.printerId===printerId&&route.category===category&&route.itemName===itemName);
    if (!duplicate) operationsConfig.routes.push({ id:operationId(), printerId, category, itemName });
  });
  return true;
}
function printKot(orderId, printerId) {
  const order = orderRecords.get(orderId);
  if (!order) return;
  const printer = operationsConfig.printers.find((item) => item.id === printerId);
  const items = (Array.isArray(order.items) ? order.items : []).filter((item) => (routePrinter(item)?.id || '') === (printerId || ''));
  if (!items.length) return;
  const popup = window.open('', 'red-lantern-kot', 'popup=yes,width=390,height=600');
  if (!popup) { alert('Please allow pop-ups to print this KOT.'); return; }
  const number=String(order.daily_order_number||'—').padStart(2,'0');
  popup.document.write(`<!doctype html><title>KOT #${esc(number)}</title><style>@page{size:80mm auto;margin:4mm}body{width:72mm;margin:0;font:12px Arial;color:#111}.center{text-align:center}.name{font-size:17px;font-weight:800}.rule{border:0;border-top:1px dashed #111;margin:9px 0}.item{padding:5px 0;font-size:13px}.item b{font-size:15px}small{color:#444}</style><div class="center"><div class="name">RED LANTERN RESTAURANT</div><b>KITCHEN ORDER TICKET</b><br><small>${esc(printer?.name || 'Unassigned')}</small></div><hr class="rule"><b>Token No: ${esc(number)}</b><br><small>${esc(order.customer_name || 'Guest')} · ${esc(order.fulfillment_type === 'pickup' ? 'Pick Up' : 'Delivery')}</small><hr class="rule">${items.map((item)=>`<div class="item"><b>${Number(item.quantity||0)}×</b> ${esc(item.name)}${item.portion?` (${esc(item.portion)})`:''}${item.style?` · ${esc(item.style)}`:''}</div>`).join('')}${order.special_request?`<hr class="rule"><b>Note:</b> ${esc(order.special_request)}`:''}<hr class="rule"><div class="center"><small>Order #${esc(number)}</small></div><script>window.onload=()=>setTimeout(()=>window.print(),120);window.onafterprint=()=>window.close();<\/script>`);
  popup.document.close();
}

async function loadAvailability() {
  const [menuResponse, availabilityResponse] = await Promise.all([fetch('/api/orders/menu', { cache: 'no-store' }), fetch('/api/orders/availability', { cache: 'no-store' })]);
  if (!menuResponse.ok || !availabilityResponse.ok) throw new Error('Menu availability could not be loaded.');
  menuItems = await menuResponse.json();
  unavailable = new Map((await availabilityResponse.json()).map((item) => [item.item_key, item.unavailable_until]));
  renderAvailability();
}

function renderAvailability() {
  const query = String(menuSearch.value || '').trim().toLowerCase();
  const typeItems = menuItems.filter((item) => item.menuType === menuType);
  const activeUnavailable = new Set([...unavailable].filter(([, until]) => new Date(until) > new Date()).map(([key]) => key));
  const unavailableForType = typeItems.filter((item) => activeUnavailable.has(item.key)).length;
  const inStockCount = typeItems.length - unavailableForType;
  document.getElementById('menu-type-tabs').innerHTML = [['food', 'Food Menu'], ['bar', 'Bar Menu']].map(([value, label]) => `<button class="menu-type-tab ${menuType === value ? 'is-active' : ''}" data-menu-type="${value}" aria-pressed="${menuType === value}">${label}<span>${menuItems.filter((item) => item.menuType === value).length}</span></button>`).join('');
  menuSearch.placeholder = `Search ${menuType === 'food' ? 'food' : 'bar'} menu`;
  document.getElementById('availability-counts').innerHTML = `<span class="stock-count in">${inStockCount} in stock</span><span class="stock-count out">${unavailableForType} unavailable</span>`;
  document.getElementById('availability-filters').innerHTML = [['all', 'All items'], ['in', 'In stock'], ['out', 'Unavailable']].map(([value, label]) => `<button class="filter-button ${availabilityFilter === value ? 'is-active' : ''}" data-availability-filter="${value}" aria-pressed="${availabilityFilter === value}">${label}</button>`).join('');
  const visible = typeItems.filter((item) => {
    const isOut = activeUnavailable.has(item.key);
    return `${item.name} ${item.category}`.toLowerCase().includes(query) && (availabilityFilter === 'all' || (availabilityFilter === 'out' ? isOut : !isOut));
  }).sort((a, b) => `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`));
  menuResults.innerHTML = visible.length ? visible.map((item) => {
    const until = activeUnavailable.has(item.key) ? unavailable.get(item.key) : null;
    const status = until ? `Out until ${new Date(until).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : 'In stock';
    return `<article class="menu-item ${until ? 'is-out' : ''}" data-key="${esc(item.key)}"><div class="menu-item-name"><b>${esc(item.name)}</b><span>${esc(item.category || 'Menu')}</span></div><div class="availability-state"><i aria-hidden="true"></i>${status}</div><div class="availability-controls">${until ? `<button class="stock-in" data-stock-action="restore">Mark in stock</button>` : `<button class="stock-tomorrow" data-stock-action="tomorrow">Out until tomorrow</button><label><span>Custom restock</span><input type="datetime-local" value="${tomorrowLocal()}" data-stock-until></label><button class="stock-date" data-stock-action="date">Mark unavailable</button>`}</div></article>`;
  }).join('') : '<div class="empty-state">No menu items match that search.</div>';
}

async function updateAvailability(key, unavailableUntil) {
  const url = `/api/orders/availability/${encodeURIComponent(key)}`;
  const response = await fetch(url, unavailableUntil ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unavailableUntil }) } : { method: 'DELETE' });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Unable to update availability.'); }
  await loadAvailability();
}

document.getElementById('availability-toggle')?.addEventListener('click', async () => {
  const isOpening = availability.hidden;
  availability.hidden = !isOpening;
  document.getElementById('availability-toggle').setAttribute('aria-expanded', String(isOpening));
  if (isOpening) { try { await loadAvailability(); } catch (error) { menuResults.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; } }
});
liveOrdersToggle.addEventListener('click', () => {
  const isOpening = liveOrdersPanel.hidden;
  liveOrdersPanel.hidden = !isOpening;
  liveOrdersToggle.classList.toggle('is-open', isOpening);
  liveOrdersToggle.setAttribute('aria-expanded', String(isOpening));
  if (isOpening) {
    orderView = 'current';
    historyAll = false;
    document.querySelectorAll('[data-order-view]').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.orderView === 'current'));
    const dateWrap = document.getElementById('history-date-wrap');
    if (dateWrap) dateWrap.hidden = true;
    loadOrders();
    liveOrdersPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
document.getElementById('availability-close')?.addEventListener('click', () => { availability.hidden = true; document.getElementById('availability-toggle').setAttribute('aria-expanded', 'false'); });
operationsToggle.addEventListener('click', async () => {
  const opening = operationsPanel.hidden;
  operationsPanel.hidden = !opening;
  operationsToggle.classList.toggle('is-open', opening);
  operationsToggle.setAttribute('aria-expanded', String(opening));
  if (!opening) return;
  document.getElementById('operations-content').innerHTML = '<div class="operations-empty">Loading Operations…</div>';
  try { await loadOrders(); await loadOperations(); await discoverSystemPrinters(); renderOperations(); operationsPanel.scrollIntoView({ behavior:'smooth', block:'start' }); } catch (error) { document.getElementById('operations-content').innerHTML = `<div class="operations-empty">${esc(error.message)}</div>`; }
});
document.getElementById('operations-close')?.addEventListener('click', () => { operationsPanel.hidden = true; operationsToggle.classList.remove('is-open'); operationsToggle.setAttribute('aria-expanded','false'); });
document.getElementById('operations-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-operations-tab]');
  if (!button) return;
  operationsTab = button.dataset.operationsTab;
  document.querySelectorAll('[data-operations-tab]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
  renderOperations();
});
document.getElementById('operations-content')?.addEventListener('change', (event) => {
  if (!event.target.matches('.operation-route-category-check')) return;
  const selected = selectedRouteCategories();
  const counter = document.getElementById('route-category-count');
  if (counter) counter.textContent = `${selected.length} selected`;
  refreshRouteItemOptions();
});
document.getElementById('operations-content')?.addEventListener('input', (event) => {
  if (event.target.id !== 'operation-route-category-search') return;
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll('.category-choice').forEach((choice) => {
    choice.classList.toggle('is-hidden', !choice.textContent.toLowerCase().includes(query));
  });
});
document.getElementById('operations-content')?.addEventListener('click', async (event) => {
  const copyBridgeCommand = event.target.closest('#copy-print-bridge-command');
  if (copyBridgeCommand) { try { await navigator.clipboard.writeText(copyBridgeCommand.dataset.command || ''); copyBridgeCommand.textContent='Copied'; setTimeout(() => { copyBridgeCommand.textContent='Copy setup command'; }, 1600); } catch (_) { alert(`Run this command in Terminal / PowerShell:\n\n${copyBridgeCommand.dataset.command || ''}`); } return; }
  const quickAdd = event.target.closest('#quick-add-printer');
  if (quickAdd) { const select=document.getElementById('quick-system-printer'); const deviceId=String(select?.value||''); const deviceName=String(select?.selectedOptions?.[0]?.textContent||''); if (!deviceId) { alert('Choose an installed system printer first.'); return; } if (operationsConfig.printers.some((printer) => printer.deviceId === deviceId)) { alert('This system printer has already been added.'); return; } operationsConfig.printers.push({ id:operationId(), name:deviceName, type:'kot', connection:'system', deviceId, deviceName }); renderOperations(); return; }
  const assignPrinter = event.target.closest('[data-assign-printer]');
  if (assignPrinter) { assignmentPrinterId=assignPrinter.dataset.assignPrinter || ''; assignmentMode='choose'; renderOperations(); return; }
  if (event.target.closest('[data-assignment-back]')) { assignmentPrinterId=''; assignmentMode=''; renderOperations(); return; }
  if (event.target.closest('[data-assign-bill]')) { const printer=operationsConfig.printers.find((item)=>item.id===assignmentPrinterId); if (printer) { printer.type='bill'; operationsConfig.routes=operationsConfig.routes.filter((route)=>route.printerId!==printer.id); try { await saveOperations(); assignmentPrinterId=''; assignmentMode=''; renderOperations(); } catch (error) { alert(error.message); } } return; }
  if (event.target.closest('[data-assign-kot]')) { assignmentMode='kot'; renderOperations(); return; }
  if (event.target.closest('[data-save-kot-assignment]')) { const printer=operationsConfig.printers.find((item)=>item.id===assignmentPrinterId); const categories=[...document.querySelectorAll('[data-assignment-category]:checked')].map((input)=>input.value); if (!categories.length) { alert('Select at least one category.'); return; } if (printer) { printer.type='kot'; operationsConfig.routes=operationsConfig.routes.filter((route)=>route.printerId!==printer.id); categories.forEach((category)=>operationsConfig.routes.push({ id:operationId(), printerId:printer.id, category, itemName:'' })); try { await saveOperations(); assignmentPrinterId=''; assignmentMode=''; renderOperations(); } catch (error) { alert(error.message); } } return; }
  const addPrinter = event.target.closest('#operation-add-printer');
  if (addPrinter) { const name=String(document.getElementById('operation-printer-name')?.value||'').trim(); const type=document.getElementById('operation-printer-type')?.value==='bill'?'bill':'kot'; const deviceSelect=document.getElementById('operation-printer-device'); const deviceId=String(deviceSelect?.value||'').trim(); const deviceName=deviceId ? String(deviceSelect?.selectedOptions?.[0]?.textContent||'').trim() : ''; if (!name) { document.getElementById('operation-printer-name')?.focus(); return; } if (!deviceId && printBridgeState === 'available') { alert('Choose an installed system printer first.'); return; } operationsConfig.printers.push({ id:operationId(), name, type, connection:'system', deviceId, deviceName }); renderOperations(); return; }
  const removePrinter = event.target.closest('[data-delete-printer]');
  if (removePrinter) { const id=removePrinter.dataset.deletePrinter; operationsConfig.printers=operationsConfig.printers.filter((printer)=>printer.id!==id); operationsConfig.routes=operationsConfig.routes.filter((route)=>route.printerId!==id); renderOperations(); return; }
  const addRoute = event.target.closest('#operation-add-route');
  if (addRoute) { try { if (!addSelectedRoutes()) { alert('Choose a KOT printer and at least one category first.'); return; } renderOperations(); } catch (error) { alert(error.message); } return; }
  const removeRoute = event.target.closest('[data-delete-route]');
  if (removeRoute) { operationsConfig.routes=operationsConfig.routes.filter((route)=>route.id!==removeRoute.dataset.deleteRoute); renderOperations(); return; }
  if (event.target.closest('#operations-save')) { const button=event.target.closest('#operations-save'); try { addSelectedRoutes(); } catch (error) { alert(error.message); return; } button.disabled=true; button.textContent='Saving…'; try { await saveOperations(); } catch(error) { alert(error.message); button.disabled=false; button.textContent='Save printer configuration'; } return; }
  const kot = event.target.closest('[data-print-kot]');
  if (kot) printKot(kot.dataset.printKot, kot.dataset.printerId);
});
orderStatusFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-status-filter]');
  if (!button) return;
  orderStatusFilter = button.dataset.orderStatusFilter;
  orderStatusFilters.querySelectorAll('[data-order-status-filter]').forEach((filter) => {
    const selected = filter === button;
    filter.classList.toggle('is-active', selected);
    filter.setAttribute('aria-pressed', String(selected));
  });
  loadOrders();
});
menuSearch?.addEventListener('input', renderAvailability);
document.getElementById('availability-filters')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-availability-filter]');
  if (!button) return;
  availabilityFilter = button.dataset.availabilityFilter;
  renderAvailability();
});
document.getElementById('menu-type-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-menu-type]');
  if (!button) return;
  menuType = button.dataset.menuType;
  availabilityFilter = 'all';
  menuSearch.value = '';
  renderAvailability();
});
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
document.getElementById('install-shortcut')?.addEventListener('click', async () => {
  const dialog = document.getElementById('shortcut-dialog');
  const message = document.getElementById('shortcut-message');
  const steps = document.getElementById('shortcut-steps');
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    return;
  }
  if (isIOS) {
    message.textContent = 'Add a secure Direct Orders icon to this iPhone.';
    steps.innerHTML = '<li>Tap the Share button in Safari.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Name it “RL Orders”, then tap Add.</li>';
  } else {
    message.textContent = 'Create a desktop shortcut for Direct Orders.';
    steps.innerHTML = '<li>Open the browser menu (⋮).</li><li>Choose <strong>Install app</strong> or <strong>Create shortcut</strong>.</li><li>Pin “RL Orders” to the taskbar or desktop.</li>';
  }
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else alert(`${message.textContent}\n\n${steps.textContent}`);
});
document.getElementById('shortcut-close')?.addEventListener('click', () => document.getElementById('shortcut-dialog')?.close());
orderSearch?.addEventListener('input', () => { clearTimeout(orderSearchTimer); orderSearchTimer = setTimeout(loadOrders, 180); });
document.getElementById('clear-order-search')?.addEventListener('click', () => { if (orderSearch) { orderSearch.value = ''; orderSearch.focus(); } loadOrders(); });
historyDate?.addEventListener('change', () => { historyAll = false; loadOrders(); });
document.getElementById('all-history')?.addEventListener('click', () => { historyAll = true; if (historyDate) historyDate.value = ''; loadOrders(); });
document.getElementById('order-view-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-view]');
  if (!button) return;
  orderView = button.dataset.orderView;
  document.querySelectorAll('[data-order-view]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
  const dateWrap = document.getElementById('history-date-wrap');
  if (dateWrap) dateWrap.hidden = orderView !== 'history';
  if (orderView === 'history' && historyDate && !historyDate.value && !historyAll) { historyDate.value = new Date().toISOString().slice(0, 10); }
  loadOrders();
});
root.addEventListener('click', (event) => { const button = event.target.closest('[data-modify-order]'); if (button) openModifyOrder(button.dataset.modifyOrder); });
menuResults?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-stock-action]');
  if (!button) return;
  const row = button.closest('[data-key]');
  const key = row?.dataset.key;
  if (!key) return;
  button.disabled = true;
  try {
    const action = button.dataset.stockAction;
    const dateInput = row.querySelector('[data-stock-until]');
    await updateAvailability(key, action === 'restore' ? null : action === 'tomorrow' ? new Date(Date.now() + 86400000).toISOString() : new Date(dateInput.value).toISOString());
  } catch (error) { alert(error.message); button.disabled = false; }
});

loadOrders();
setInterval(loadOrders, 3000);
