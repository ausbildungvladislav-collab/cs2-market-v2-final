(() => {
"use strict";
const CURRENCY_RATES={EUR:1,USD:1.08,RUB:97},CURRENCY_SYMBOLS={EUR:"€",USD:"$",RUB:"₽"};
const skins=[
{id:"ak-redline",name:"AK-47 | Redline",weapon:"AK-47",wear:"Field-Tested",rarity:"Classified",price:18.5,emoji:"🔫",glow:"#d64b4b"},
{id:"awp-asiimov",name:"AWP | Asiimov",weapon:"AWP",wear:"Field-Tested",rarity:"Covert",price:92,emoji:"🎯",glow:"#ff8b35"},
{id:"deagle-blaze",name:"Desert Eagle | Blaze",weapon:"Desert Eagle",wear:"Factory New",rarity:"Restricted",price:74,emoji:"🔫",glow:"#e99b32"},
{id:"m4a1-hyper",name:"M4A1-S | Hyper Beast",weapon:"M4A1-S",wear:"Minimal Wear",rarity:"Covert",price:61,emoji:"🐉",glow:"#c34c8b"},
{id:"usp-kill",name:"USP-S | Kill Confirmed",weapon:"USP-S",wear:"Field-Tested",rarity:"Covert",price:48,emoji:"🔫",glow:"#d84e4e"},
{id:"karambit-blue",name:"Karambit | Blue Steel",weapon:"Karambit",wear:"Minimal Wear",rarity:"Covert",price:210,emoji:"🔪",glow:"#4c9fe0"},
{id:"glock-fade",name:"Glock-18 | Fade",weapon:"Glock-18",wear:"Factory New",rarity:"Restricted",price:135,emoji:"🔫",glow:"#d7a64a"},
{id:"ak-neon",name:"AK-47 | Neon Rider",weapon:"AK-47",wear:"Minimal Wear",rarity:"Covert",price:39,emoji:"🌈",glow:"#bc48b5"},
{id:"m4a4-emperor",name:"M4A4 | The Emperor",weapon:"M4A4",wear:"Field-Tested",rarity:"Covert",price:27,emoji:"👑",glow:"#d3a84a"},
{id:"usp-cortex",name:"USP-S | Cortex",weapon:"USP-S",wear:"Minimal Wear",rarity:"Classified",price:8.4,emoji:"🔫",glow:"#e27a9d"},
{id:"awp-mortis",name:"AWP | Mortis",weapon:"AWP",wear:"Field-Tested",rarity:"Classified",price:6.2,emoji:"🎯",glow:"#b74b52"},
{id:"p250-see",name:"P250 | See Ya Later",weapon:"P250",wear:"Minimal Wear",rarity:"Covert",price:14.7,emoji:"🐊",glow:"#64b6a4"},
{id:"five-seven",name:"Five-SeveN | Hyper Beast",weapon:"Five-SeveN",wear:"Field-Tested",rarity:"Classified",price:11.3,emoji:"🐲",glow:"#b54f94"},
{id:"galil-sugar",name:"Galil AR | Sugar Rush",weapon:"Galil AR",wear:"Field-Tested",rarity:"Classified",price:19.2,emoji:"🍬",glow:"#db78bd"},
{id:"mac10-neon",name:"MAC-10 | Neon Rider",weapon:"MAC-10",wear:"Minimal Wear",rarity:"Classified",price:12.5,emoji:"🌈",glow:"#ad52c1"},
{id:"usp-print",name:"USP-S | Printstream",weapon:"USP-S",wear:"Field-Tested",rarity:"Covert",price:55,emoji:"⚪",glow:"#c5d0d9"},
{id:"m4a4-neo",name:"M4A4 | Neo-Noir",weapon:"M4A4",wear:"Field-Tested",rarity:"Covert",price:33,emoji:"🌌",glow:"#7f6be8"},
{id:"awp-lightning",name:"AWP | Lightning Strike",weapon:"AWP",wear:"Factory New",rarity:"Covert",price:380,emoji:"⚡",glow:"#6b8cff"},
{id:"knife-tiger",name:"Huntsman Knife | Tiger Tooth",weapon:"Huntsman Knife",wear:"Factory New",rarity:"Covert",price:245,emoji:"🗡️",glow:"#e5a82c"},
{id:"mac10-disco",name:"MAC-10 | Disco Tech",weapon:"MAC-10",wear:"Minimal Wear",rarity:"Classified",price:16,emoji:"🪩",glow:"#b45ae8"}
];
const cases=[
{id:"starter",name:"Starter Case",description:"Базовые скины для начала коллекции.",price:4.5,emoji:"▤",pool:["usp-cortex","awp-mortis","five-seven","ak-neon","ak-redline"]},
{id:"weapon",name:"Weapon Case",description:"Популярные предметы и редкие находки.",price:12,emoji:"▣",pool:["ak-redline","m4a4-emperor","p250-see","galil-sugar","usp-kill","m4a1-hyper"]},
{id:"elite",name:"Elite Case",description:"Шанс получить дорогой скин.",price:30,emoji:"✦",pool:["awp-asiimov","karambit-blue","glock-fade","usp-print","m4a1-hyper","awp-lightning"]},
{id:"knife",name:"Knife Case",description:"Коллекция ножей и редких предметов.",price:55,emoji:"⚔",pool:["karambit-blue","knife-tiger","glock-fade","awp-asiimov"]}
];
const rarityColors={Covert:"#e14b62",Classified:"#c05be5",Restricted:"#8b79ef","Mil-Spec":"#4e8de5"};
const $=id=>document.getElementById(id),getSkin=id=>skins.find(s=>s.id===id);
const defaultState=()=>({balance:0,currency:"EUR",inventory:[],username:"PLAYER",transactions:[],lastBonus:null,cosmetics:[],selectedFrame:"default",premiumUntil:0});
let state=loadState(),selectedSourceId=null,toastTimer,mines=null,crash=null,crashTimer=null;
function loadState(){try{const s=JSON.parse(localStorage.getItem("cs2MarketFull"));if(s&&typeof s.balance==="number")return{...defaultState(),...s,inventory:(s.inventory||[]).filter(id=>getSkin(id)),cosmetics:Array.isArray(s.cosmetics)?s.cosmetics:[]};}catch(e){console.warn(e)}return defaultState()}
function saveState(){localStorage.setItem("cs2MarketFull",JSON.stringify(state))}
function formatPrice(v){return new Intl.NumberFormat("ru-RU",{minimumFractionDigits:2,maximumFractionDigits:2}).format(v*CURRENCY_RATES[state.currency])+" "+CURRENCY_SYMBOLS[state.currency]}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2300)}
function transact(label,amount){state.transactions.unshift({label,amount});state.transactions=state.transactions.slice(0,30)}
function skinCard(s,action,label){const owned=state.inventory.includes(s.id);return `<article class="skin-card" ${action==="select"?'data-select="'+s.id+'"':''}><div class="skin-art" style="--skin-glow:${s.glow};--rarity-color:${rarityColors[s.rarity]||"#9aa"}"><span class="rarity-bar"></span><span class="rarity-tag">${escapeHtml(s.rarity)}</span><span class="skin-emoji">${s.emoji}</span></div><div class="skin-body"><div class="skin-type">${escapeHtml(s.weapon)}</div><div class="skin-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div><div class="skin-wear">${escapeHtml(s.wear)}</div><div class="skin-footer"><span class="skin-price">${formatPrice(s.price)}</span><button class="mini-btn" data-action="${action}" data-id="${s.id}" ${action==="buy"&&owned?"disabled":""}>${action==="buy"&&owned?"Есть":label}</button></div></div></article>`}
function renderGrid(id,list,action,label,empty){$(id).innerHTML=list.length?list.map(s=>skinCard(s,action,label)).join(""):`<div class="empty-state">${empty}</div>`}
function inventorySkins(){return state.inventory.map(getSkin).filter(Boolean)}
function inventoryValue(){return inventorySkins().reduce((n,s)=>n+s.price,0)}
function renderAll(){
 $("balanceValue").textContent=formatPrice(state.balance);$("walletBalance").textContent=formatPrice(state.balance);$("marketCount").textContent=skins.length;$("marketPageCount").textContent=skins.length;
 $("inventoryCount").textContent=state.inventory.length;$("inventoryPageCount").textContent=state.inventory.length;$("inventoryValue").textContent=formatPrice(inventoryValue());
 $("profileBalance").textContent=formatPrice(state.balance);$("profileItems").textContent=state.inventory.length;$("profileValue").textContent=formatPrice(inventoryValue());$("profileCurrency").textContent=state.currency;
 $("username").textContent=state.username;$("profileName").textContent=state.username;renderMembership();
 renderGrid("featuredGrid",skins.slice(0,4),"buy","Купить","Нет предметов");renderMarket();renderGrid("inventoryGrid",inventorySkins(),"select","Выбрать","Инвентарь пуст. Купи скин или открой кейс.");
 renderCases();renderUpgrader();renderTransactions();
}
function renderMarket(){let q=$("searchInput").value.trim().toLowerCase(),r=$("rarityFilter").value,sort=$("sortSelect").value;let list=skins.filter(s=>(s.name.toLowerCase().includes(q)||s.weapon.toLowerCase().includes(q))&&(r==="all"||s.rarity===r));if(sort==="low")list.sort((a,b)=>a.price-b.price);if(sort==="high")list.sort((a,b)=>b.price-a.price);renderGrid("marketGrid",list,"buy","Купить","Ничего не найдено.")}
function renderCases(){$("casesGrid").innerHTML=cases.map(c=>`<article class="case-card"><div class="case-art">${c.emoji}</div><h3>${escapeHtml(c.name)}</h3><p>${escapeHtml(c.description)}</p><div class="case-footer"><span class="case-price">${formatPrice(c.price)}</span><button class="mini-btn" data-action="open-case" data-id="${c.id}">Открыть</button></div></article>`).join("")}
function renderUpgrader(){let source=selectedSourceId?getSkin(selectedSourceId):null;if(!source||!state.inventory.includes(source.id)){selectedSourceId=null;$("upgradeSource").className="upgrade-selection empty-selection";$("upgradeSource").textContent=state.inventory.length?"Выбери предмет в инвентаре.":"Сначала добавь предмет в инвентарь."}else{$("upgradeSource").className="upgrade-selection";$("upgradeSource").innerHTML=`<div class="source-item"><span class="skin-emoji">${source.emoji}</span><div><strong>${escapeHtml(source.name)}</strong><small>${formatPrice(source.price)}</small></div></div>`}let sel=$("upgradeTarget"),prev=sel.value,targets=source?skins.filter(s=>s.price>source.price):[];sel.innerHTML='<option value="">Выбери целевой скин</option>'+targets.map(s=>`<option value="${s.id}">${escapeHtml(s.name)} — ${formatPrice(s.price)}</option>`).join("");if(targets.some(s=>s.id===prev))sel.value=prev;updateChance()}
function updateChance(){let a=getSkin(selectedSourceId),b=getSkin($("upgradeTarget").value),chance=a&&b?Math.max(1,Math.min(90,Math.round(a.price/b.price*75))):0;$("upgradeChance").textContent=chance+"%";$("chanceBar").style.width=chance+"%";$("upgradeButton").disabled=!(a&&b&&state.inventory.includes(a.id)&&b.price>a.price)}
function buySkin(id){let s=getSkin(id);if(!s||state.inventory.includes(id))return;if(state.balance<s.price)return toast("Недостаточно виртуальных кредитов.");state.balance-=s.price;state.inventory.push(id);transact("Покупка: "+s.name,-s.price);saveState();renderAll();toast("Скин добавлен в инвентарь.")}
function sellSkin(id){let i=state.inventory.indexOf(id),s=getSkin(id);if(i<0||!s)return;state.inventory.splice(i,1);let value=s.price*.9;state.balance+=value;if(selectedSourceId===id)selectedSourceId=null;transact("Продажа: "+s.name,value);saveState();renderAll();toast("Предмет продан за 90% стоимости.")}
function openCase(id){let c=cases.find(x=>x.id===id);if(!c)return;if(state.balance<c.price)return toast("Недостаточно виртуальных кредитов.");state.balance-=c.price;let drop=getSkin(c.pool[Math.floor(Math.random()*c.pool.length)]);state.inventory.push(drop.id);transact("Открытие: "+c.name,-c.price);$("caseResult").classList.remove("hidden");$("caseResult").innerHTML=`<span class="skin-emoji">${drop.emoji}</span><div><div class="result-kicker">КЕЙС ОТКРЫТ · ТВОЙ ДРОП</div><h3>${escapeHtml(drop.name)}</h3><p>Добавлен в инвентарь · ${formatPrice(drop.price)}</p></div>`;saveState();renderAll();toast("Кейс открыт!")}
function runUpgrade(){let a=getSkin(selectedSourceId),b=getSkin($("upgradeTarget").value);if(!a||!b||!state.inventory.includes(a.id)||b.price<=a.price)return;let chance=Math.max(1,Math.min(90,Math.round(a.price/b.price*75))),ok=Math.random()*100<chance;state.inventory.splice(state.inventory.indexOf(a.id),1);if(ok){state.inventory.push(b.id);transact("Апгрейд: "+b.name,0);toast("Успех! Получен "+b.name)}else{transact("Неудачный апгрейд: "+a.name,0);toast("Неудача. Предмет потерян.")}selectedSourceId=null;$("upgradeTarget").value="";saveState();renderAll()}
function showPage(name){const ids=["home","market","inventory","cases","upgrader","games","wallet","premium","profile"];ids.forEach(k=>$(k+"Page").classList.toggle("hidden",k!==name));document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));window.scrollTo({top:0,behavior:"smooth"});if(name==="upgrader")renderUpgrader()}
function renderTransactions(){$("transactionList").innerHTML=state.transactions.length?state.transactions.slice(0,12).map(t=>`<div class="transaction"><span>${escapeHtml(t.label)}</span><span>${t.amount>0?"+":""}${formatPrice(t.amount)}</span></div>`).join(""):'<div class="empty-state">Операций пока нет.</div>'}
function validBet(id){let n=Number($(id).value);if(!Number.isFinite(n)||n<10||n>10000||n>state.balance){toast("Минимальная ставка — 10, максимум — 10 000 и не больше баланса.");return null}return Math.floor(n)}
function changeBalance(amount,label){state.balance=Math.max(0,state.balance+amount);transact(label,amount);saveState();renderAll()}
function switchGame(game){document.querySelectorAll(".game-tab").forEach(b=>b.classList.toggle("active",b.dataset.game===game));["mines","coinflip","roulette","crash"].forEach(k=>$(k+"Game").classList.toggle("hidden",k!==game))}
function startMines(){if(mines?.active)return toast("Сначала заверши текущий раунд.");let bet=validBet("minesBet");if(!bet)return;let count=Number($("minesCount").value),bombs=new Set();while(bombs.size<count)bombs.add(Math.floor(Math.random()*25));state.balance-=bet;transact("Mines: ставка",-bet);saveState();renderAll();mines={bet,count,bombs,opened:new Set(),active:true};$("minesGrid").innerHTML=Array.from({length:25},(_,i)=>`<button class="mine-cell" data-cell="${i}" aria-label="Клетка ${i+1}">?</button>`).join("");$("minesStatus").textContent="Раунд начался. Открывай клетки или забери выигрыш.";updateMines()}
function mineMultiplier(){let n=mines.opened.size;if(!n)return 1;let safe=25-mines.count,m=1;for(let i=0;i<n;i++)m*=((25-i)/(safe-i));return Math.max(1,Math.round(m*.97*100)/100)}
function updateMines(){$("minesMultiplier").textContent=mineMultiplier().toFixed(2)+"x";$("minesCashout").disabled=!(mines?.active&&mines.opened.size>0)}
function revealMines(hit){document.querySelectorAll(".mine-cell").forEach((b,i)=>{if(mines.bombs.has(i)){b.textContent="💣";b.classList.add("mine")}else if(mines.opened.has(i)){b.textContent="💎";b.classList.add("safe")}b.disabled=true});mines.active=false;$("minesCashout").disabled=true;if(hit)$("minesStatus").textContent="Бомба! Раунд проигран. Попробуй ещё раз.";else $("minesStatus").textContent="Раунд завершён."}
function clickMine(i){if(!mines?.active||mines.opened.has(i))return;let b=document.querySelector(`[data-cell="${i}"]`);if(mines.bombs.has(i)){b.textContent="💣";b.classList.add("mine");revealMines(true);return}mines.opened.add(i);b.textContent="💎";b.classList.add("safe");b.disabled=true;updateMines();if(mines.opened.size===25-mines.count){cashoutMines(true)}}
function cashoutMines(auto=false){if(!mines?.active||!mines.opened.size)return;let win=Number((mines.bet*mineMultiplier()).toFixed(2));state.balance+=win;transact("Mines: выигрыш",win);revealMines(false);$("minesStatus").textContent=(auto?"Все безопасные клетки! ":"Вы забрали выигрыш: ")+formatPrice(win);saveState();renderAll()}
function playCoin(){let bet=validBet("coinBet");if(!bet)return;let choice=$("coinChoice").value,result=Math.random()<.5?"heads":"tails",won=choice===result;state.balance-=bet;if(won)state.balance+=bet*1.9;transact("Coinflip: "+(won?"выигрыш":"проигрыш"),won?bet*.9:-bet);$("coinResult").textContent=result==="heads"?"🪙 ОРЁЛ":"🪙 РЕШКА";$("coinStatus").textContent=won?"Угадал! Начислено "+formatPrice(bet*1.9):"Не угадал. Ставка проиграна.";saveState();renderAll()}
function playRoulette(){let bet=validBet("rouletteBet");if(!bet)return;let roll=Math.random(),result=roll<.475?"red":roll<.95?"black":"green",choice=$("rouletteChoice").value,mult=result==="green"?14:2,won=choice===result;state.balance-=bet;if(won)state.balance+=bet*mult;transact("Roulette: "+(won?"выигрыш":"проигрыш"),won?bet*(mult-1):-bet);$("rouletteResult").textContent=result==="red"?"🔴 КРАСНОЕ":result==="black"?"⚫ ЧЁРНОЕ":"🟢 ЗЕЛЁНОЕ";$("rouletteStatus").textContent=won?"Победа! Выплата "+formatPrice(bet*mult):"Не угадал. Ставка проиграна.";saveState();renderAll()}
function startCrash(){if(crash?.active)return;let bet=validBet("crashBet");if(!bet)return;state.balance-=bet;transact("Crash: ставка",-bet);saveState();renderAll();let point=Math.max(1.05,Math.min(12,1+(-Math.log(Math.random())*2.2)));crash={bet,point,mult:1,active:true,start:Date.now()};$("crashStatus").textContent="Раунд идёт! Забери до краша."; $("crashStart").disabled=true;$("crashCashout").disabled=false;clearInterval(crashTimer);crashTimer=setInterval(()=>{if(!crash?.active)return;crash.mult=Math.pow(1.0015,Date.now()-crash.start);$("crashMultiplier").textContent=crash.mult.toFixed(2)+"x";$("crashGraph").textContent=crash.mult.toFixed(2)+"x";$("crashRocket").style.transform=`translate(${Math.min(100,crash.mult*7)}px,-${Math.min(65,crash.mult*5)}px)`;if(crash.mult>=crash.point)finishCrash(false)},50)}
function finishCrash(cashed){if(!crash?.active)return;crash.active=false;clearInterval(crashTimer);$("crashStart").disabled=false;$("crashCashout").disabled=true;if(cashed){let win=Number((crash.bet*crash.mult).toFixed(2));state.balance+=win;transact("Crash: выигрыш",win);$("crashStatus").textContent="Забрал "+formatPrice(win)+" на "+crash.mult.toFixed(2)+"x";}else{$("crashStatus").textContent="CRASH на "+crash.point.toFixed(2)+"x. Ставка проиграна."}saveState();renderAll()}
document.addEventListener("click",e=>{let tab=e.target.closest("[data-tab]");if(tab){e.preventDefault();showPage(tab.dataset.tab);return}let action=e.target.closest("[data-action]");if(action){let {action:k,id}=action.dataset;if(k==="buy")buySkin(id);if(k==="sell")sellSkin(id);if(k==="open-case")openCase(id);if(k==="select"){selectedSourceId=id;showPage("upgrader");}return}let cell=e.target.closest("[data-cell]");if(cell)clickMine(Number(cell.dataset.cell));let game=e.target.closest("[data-game]");if(game)switchGame(game.dataset.game)});
$("currencySelect").addEventListener("change",e=>{state.currency=e.target.value;saveState();renderAll()});$("searchInput").addEventListener("input",renderMarket);$("rarityFilter").addEventListener("change",renderMarket);$("sortSelect").addEventListener("change",renderMarket);$("upgradeTarget").addEventListener("change",updateChance);$("upgradeButton").addEventListener("click",runUpgrade);
$("minesStart").addEventListener("click",startMines);$("minesCashout").addEventListener("click",()=>cashoutMines());$("coinPlay").addEventListener("click",playCoin);$("roulettePlay").addEventListener("click",playRoulette);$("crashStart").addEventListener("click",startCrash);$("crashCashout").addEventListener("click",()=>finishCrash(true));
$("dailyBonus").addEventListener("click",()=>{let today=new Date().toDateString();if(state.lastBonus===today)return toast("Ежедневный бонус уже получен.");state.lastBonus=today;changeBalance(50,"Ежедневный бонус");toast("Бонус +50 виртуальных кредитов!")});

const API_BASE=window.CS2_API_BASE||"";
const cosmeticCatalog=[
 {id:"frame_neon",name:"Neon Frame",description:"Неоновая рамка профиля",price:25,emoji:"🟢",className:"frame-neon"},
 {id:"frame_gold",name:"Gold Frame",description:"Золотая рамка профиля",price:50,emoji:"👑",className:"frame-gold"},
 {id:"frame_violet",name:"Violet Frame",description:"Фиолетовая рамка профиля",price:35,emoji:"💜",className:"frame-violet"}
];
let serverAccount=null;
function isPremium(){return Number(serverAccount?.premiumUntil||0)>Date.now()}
function renderMembership(){
 const active=isPremium();
 const badge=$("premiumBadge"),status=$("profileStatus"),expiry=$("premiumExpiry"),premiumStatus=$("premiumStatus"),avatar=$("profileAvatar");
 if(badge)badge.classList.toggle("hidden",!active);
 if(status)status.textContent=active?"✦ Premium участник":"Обычный аккаунт";
 if(premiumStatus)premiumStatus.textContent=active?"✦ Premium активен":"Обычный аккаунт";
 if(expiry)expiry.textContent=active?"Действует до: "+new Date(serverAccount.premiumUntil).toLocaleDateString("ru-RU"):"Активного Premium пока нет.";
 if(avatar){avatar.classList.remove("frame-neon","frame-gold","frame-violet");if(state.selectedFrame&&state.selectedFrame!=="default")avatar.classList.add(state.selectedFrame)}
 renderCosmetics();
}
function renderCosmetics(){
 const root=$("cosmeticGrid");if(!root)return;
 root.innerHTML=cosmeticCatalog.map(c=>{const owned=(serverAccount?.cosmetics||[]).includes(c.id),selected=state.selectedFrame===c.className;return `<article class="cosmetic-card"><div class="cosmetic-preview ${c.className}">${c.emoji}</div><h3>${c.name}</h3><p>${c.description}</p><div class="cosmetic-footer"><strong>${owned?"Куплено":c.price+" ⭐"}</strong><button class="mini-btn" data-cosmetic="${c.id}" ${selected?"disabled":""}>${selected?"Выбрано":owned?"Применить":"Купить"}</button></div></article>`}).join("");
}
async function apiRequest(path,body){
 const tgApp=window.Telegram?.WebApp,initData=tgApp?.initData;
 if(!initData){toast("Открой приложение через Telegram, чтобы использовать Premium.");throw new Error("Telegram initData missing")}
 const response=await fetch(API_BASE+path,{method:"POST",headers:{"Content-Type":"application/json","X-Telegram-Init-Data":initData},body:JSON.stringify(body||{})});
 const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Ошибка сервера");return data;
}
async function refreshAccount(){try{const tgApp=window.Telegram?.WebApp;if(!tgApp?.initData)return;const response=await fetch(API_BASE+"/api/me",{headers:{"X-Telegram-Init-Data":tgApp.initData}});if(!response.ok)return;serverAccount=await response.json();if(serverAccount.user?.first_name){state.username=serverAccount.user.first_name.toUpperCase();saveState()}renderAll()}catch(e){console.warn("Account sync:",e)}}
async function purchaseProduct(productId){try{const data=await apiRequest("/api/create-invoice",{productId});if(!data.invoiceLink)throw new Error("Сервер не вернул ссылку на оплату");const tgApp=window.Telegram?.WebApp;if(!tgApp?.openInvoice){window.open(data.invoiceLink,"_blank");return}tgApp.openInvoice(data.invoiceLink,async status=>{if(status==="paid"){toast("Оплата получена. Обновляем Premium…");setTimeout(refreshAccount,1200)}else if(status==="failed")toast("Оплата не прошла.");else if(status==="cancelled")toast("Оплата отменена.")})}catch(e){toast(e.message||"Не удалось создать платёж")}}
$("buyPremium").addEventListener("click",()=>purchaseProduct("premium_30d"));
document.addEventListener("click",e=>{const b=e.target.closest("[data-cosmetic]");if(!b)return;const c=cosmeticCatalog.find(x=>x.id===b.dataset.cosmetic);if(!c)return;if((serverAccount?.cosmetics||[]).includes(c.id)){state.selectedFrame=c.className;saveState();renderMembership();toast("Оформление профиля изменено.")}else purchaseProduct(c.id)});
const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand();let first=tg.initDataUnsafe?.user?.first_name;if(first)state.username=first.toUpperCase()}
refreshAccount();
$("currencySelect").value=state.currency;renderAll();
})();