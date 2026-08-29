// 闲时判定核心（读 2026 节假日/调休配置 + 工作日窗口）
const fs=require('fs');
function load(cfgPath){const c=JSON.parse(fs.readFileSync(cfgPath,'utf8'));return {holidays:new Set(c.holidays),workdays:new Set(c.workdays),idleWindows:c.idleWindows};}
function iso(d){const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
const state=load('/root/.dsh/idle-scheduler/2026-holidays.json');
function isWorkday(d){
  const ds=iso(d);
  if(state.workdays.has(ds)) return true;      // 调休上班(即使周末)
  if(state.holidays.has(ds)) return false;     // 法定放假
  const wd=d.getDay(); return wd>=1&&wd<=5;    // 周一~周五
}
function minOf(d){return d.getHours()*60+d.getMinutes();}
function parseMM(t){const[a,b]=t.split(':').map(Number);return a*60+b;}
function isIdleNow(d){
  if(!isWorkday(d)) return true;               // 节假日/周末 → 全天闲时
  const x=minOf(d);
  return state.idleWindows.some(w=>x>=parseMM(w.start)&&x<=parseMM(w.end));
}
module.exports={isWorkday,isIdleNow,iso,state};
