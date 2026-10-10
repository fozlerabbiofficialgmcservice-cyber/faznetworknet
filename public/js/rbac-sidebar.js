'use strict';
(function(){
  const body=document.body;
  const role=String(body.dataset.userRole||'super_admin');
  const currentUserId=Number(body.dataset.adminId||0);
  const allowedTopMenus=role==='super_admin'?null:role==='admin'
    ?new Set(['Dashboard','Customer','Report','Payments','Account & Support','Staff Management'])
    :new Set(['Dashboard','Customer','Account & Support']);
  const esc=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function applyRoleNavigation(){
    document.querySelectorAll('#sidebar > .sidebar-menu > .menu-item').forEach(item=>{
      const label=(item.querySelector(':scope > a span, :scope > button span')?.textContent||'').trim();
      if(allowedTopMenus&&!allowedTopMenus.has(label)) item.hidden=true;
      if(role==='staff'){
        item.querySelectorAll('a,button').forEach(control=>{
          const text=(control.textContent||'').trim().toLowerCase();
          if(/add customer|due collection|add expenses|delete|edit|sync|push exp|restore missing|settings|manage|payment|invoice|billing/.test(text)) control.hidden=true;
        });
        if(label==='Customer') item.querySelectorAll('.submenu > li').forEach(li=>{
          if(/add customer|due collection/i.test(li.textContent||'')) li.hidden=true;
        });
      }
    });
    document.querySelectorAll('[data-rbac-roles]').forEach(el=>{
      const allowed=String(el.dataset.rbacRoles||'').split(',').map(x=>x.trim());
      el.hidden=!allowed.includes(role);
    });
    const roleSelect=document.getElementById('rbacRole');
    if(roleSelect&&role!=='super_admin'){
      roleSelect.querySelector('[data-super-admin-only]')?.remove();
      if(role==='admin'){roleSelect.innerHTML='<option value="staff">Staff</option>';roleSelect.value='staff';}
    }
  }
  window.loadStaffManagement=async function(){
    if(!['super_admin','admin'].includes(role)){window.alert('You do not have permission to view staff management.');return;}
    if(typeof window.switchView==='function') window.switchView('staff-management');
    const tbody=document.getElementById('rbacUsersBody');
    if(!tbody)return;
    tbody.innerHTML='<tr><td colspan="7" class="text-center text-muted py-4">Loading accounts…</td></tr>';
    try{
      const response=await fetch('/api/admin/users',{credentials:'same-origin',headers:{Accept:'application/json'}});
      const data=await response.json();
      if(!response.ok||!data.success)throw new Error(data.message||'Unable to load accounts.');
      tbody.innerHTML=(data.users||[]).map(user=>{
        const created=user.created_at?new Date(user.created_at).toLocaleDateString('en-GB',{timeZone:'Asia/Dhaka'}):'—';
        const active=String(user.status)==='active';
        const canManage=(role==='super_admin'||user.role==='staff')&&Number(user.id)!==currentUserId;
        return '<tr><td class="fw-semibold">'+esc(user.username)+'</td><td>'+esc(user.email)+'</td><td><span class="badge text-bg-'+(user.role==='super_admin'?'dark':user.role==='admin'?'primary':'secondary')+'">'+esc(user.role)+'</span></td><td>'+(user.is_first_login?'Pending verification':'Verified')+'</td><td><span class="badge text-bg-'+(active?'success':'secondary')+'">'+esc(user.status)+'</span></td><td>'+esc(created)+'</td><td>'+(canManage?'<button class="btn btn-sm '+(active?'btn-outline-danger':'btn-outline-success')+'" data-user-id="'+Number(user.id)+'" data-next-status="'+(active?'disabled':'active')+'">'+(active?'Disable':'Enable')+'</button>':'—')+'</td></tr>';
      }).join('')||'<tr><td colspan="7" class="text-center text-muted py-4">No accounts found.</td></tr>';
      tbody.querySelectorAll('button[data-user-id]').forEach(button=>button.addEventListener('click',async()=>{
        if(!window.confirm('Change this account status?'))return;
        button.disabled=true;
        try{
          const response=await fetch('/api/admin/users/'+button.dataset.userId+'/status',{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({status:button.dataset.nextStatus})});
          const data=await response.json();
          if(!response.ok||!data.success)throw new Error(data.message||'Unable to update account.');
          await window.loadStaffManagement();
        }catch(error){window.alert(error.message);button.disabled=false;}
      }));
    }catch(error){tbody.innerHTML='<tr><td colspan="7" class="text-danger text-center py-4">'+esc(error.message)+'</td></tr>';}
  };
  document.addEventListener('DOMContentLoaded',applyRoleNavigation,{once:true});
  if(document.readyState!=='loading')applyRoleNavigation();
  if(role==='staff'){
    const hideMutationControls=root=>{
      (root||document).querySelectorAll('button,a,[role="button"]').forEach(control=>{
        const label=(control.getAttribute('title')||control.getAttribute('aria-label')||control.textContent||'').trim().toLowerCase();
        if(/\b(edit|delete|remove|renew|kick|provision|sync|restore|change package|mark paid|manual match|push exp)\b/.test(label)) control.hidden=true;
      });
      (root||document).querySelectorAll('input[type="submit"],button[type="submit"]').forEach(control=>{
        const label=(control.textContent||control.value||'').trim().toLowerCase();
        if(/save|create|update|delete|renew|provision|sync/.test(label)) control.hidden=true;
      });
    };
    hideMutationControls();
    const dynamicContent=document.getElementById('dynamicPageContent');
    if(dynamicContent&&typeof MutationObserver!=='undefined'){
      new MutationObserver(()=>hideMutationControls(dynamicContent)).observe(dynamicContent,{childList:true,subtree:true});
    }
  }
  const form=document.getElementById('rbacCreateUserForm');
  if(form)form.addEventListener('submit',async event=>{
    event.preventDefault();
    const result=document.getElementById('rbacCreateUserResult');
    const button=document.getElementById('rbacCreateUserBtn');
    result.className='small text-muted';result.textContent='Creating account…';button.disabled=true;
    try{
      const payload=Object.fromEntries(new FormData(form).entries());
      const response=await fetch('/api/admin/users',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload)});
      const data=await response.json();
      if(!response.ok||!data.success)throw new Error(data.message||'Unable to create account.');
      result.className='small text-success';result.textContent=data.message||'Account created.';form.reset();
      await window.loadStaffManagement();
    }catch(error){result.className='small text-danger';result.textContent=error.message;}
    finally{button.disabled=false;}
  });
})();
