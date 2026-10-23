const $=id=>document.getElementById(id);
let view=location.pathname.slice(1);if(!['tickets','customers','assets'].includes(view))view='tickets';
let page=1,query='',total=0;
const titles={tickets:['工单中心','全部工单'],customers:['客户档案','服务客户'],assets:['设备台账','在册设备']};
const columns={tickets:[['id','编号'],['title','工单主题'],['owner','负责人'],['priority','优先级'],['status','状态'],['updated','更新时间']],customers:[['id','编号'],['name','客户名称'],['contact','联系人'],['email','服务邮箱'],['tier','服务等级']],assets:[['code','设备编号'],['name','设备类型'],['customerId','客户编号'],['location','部署位置'],['status','状态']]};
async function api(path,options){const r=await fetch(path,options);const data=await r.json();if(!r.ok)throw new Error(data.error??'请求失败');return data;}
async function load(){
 $('notice').textContent='正在读取记录…';
 try {
  const data=await api(`/api/${view}?page=${page}&q=${encodeURIComponent(query)}`);total=data.total;
  $('columns').replaceChildren();const tr=document.createElement('tr');for(const [,title]of columns[view]){const th=document.createElement('th');th.textContent=title;tr.append(th);}const th=document.createElement('th');th.textContent='操作';tr.append(th);$('columns').append(tr);
  $('rows').replaceChildren();for(const row of data.items){const tr=document.createElement('tr');for(const [key]of columns[view]){const td=document.createElement('td');td.textContent=row[key];tr.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.textContent='详情';button.className='secondary';button.onclick=()=>detail(row.id);td.append(button);tr.append(td);$('rows').append(tr);}
  $('notice').textContent=total?'':'没有符合条件的记录';$('count').textContent=`共 ${total} 条记录`;$('page').textContent=`${page} / ${Math.max(1,Math.ceil(total/10))}`;$('prev').disabled=page<=1;$('next').disabled=page*10>=total;
 }catch(e){$('notice').textContent=e.message;}
}
async function detail(id){try{const row=await api(`/api/${view}/${id}`);$('detail-body').replaceChildren();const names=Object.fromEntries([...columns[view],['description','处理说明'],['customerId','客户编号'],['assetId','关联设备']]);for(const[k,v]of Object.entries(row)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=names[k]??k;dd.textContent=v;$('detail-body').append(dt,dd);}$('detail').showModal();}catch(e){$('notice').textContent=e.message;}}
function showDesk(me){$('login').hidden=true;$('desk').hidden=false;$('identity').textContent=me.name+' · '+me.role;$('heading').textContent=titles[view][0];$('breadcrumb').textContent=titles[view][0];$('list-title').textContent=titles[view][1];document.querySelectorAll('[data-view]').forEach(a=>a.classList.toggle('active',a.dataset.view===view));return load();}
$('login-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;$('login-error').textContent='';try{await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});await showDesk(await api('/api/me'));history.replaceState(null,'','/'+view);}catch(e){$('login-error').textContent=e.message;}finally{button.disabled=false;}};
$('search').onsubmit=e=>{e.preventDefault();query=new FormData(e.target).get('q');page=1;load();};$('prev').onclick=()=>{page--;load();};$('next').onclick=()=>{page++;load();};$('detail').querySelector('button').onclick=()=>$('detail').close();$('logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.href='/login';};
try{await showDesk(await api('/api/me'));}catch{$('login').hidden=false;$('desk').hidden=true;}
