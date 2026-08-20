// "My Skins" screen: shows only the skins the signed-in account actually owns (free skins
// count as owned), and lets them equip one. Purchasing lives entirely in shop.js/the Shop
// screen instead -- this module has no BUY path at all, only EQUIP, so a player picking an
// avatar never has to wade through priced items they don't own yet.
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function createMySkins({ auth, elements }){
  const { listEl, statusEl } = elements;
  const sb = auth ? auth.getClient() : null;

  let renderGeneration = 0;

  async function render(){
    const myGeneration = ++renderGeneration;
    if (!sb){
      listEl.innerHTML = '';
      statusEl.textContent = 'Unavailable right now.';
      return;
    }

    const { session, profile } = auth.getState();
    if (!session){
      listEl.innerHTML = '';
      statusEl.textContent = 'Sign in from the title screen to pick your skin.';
      return;
    }

    listEl.innerHTML = '<p style="color:#9be8ac; font-size:13px;">Loading…</p>';
    statusEl.textContent = '';

    const { data: skins, error: skinsError } = await sb
      .from('skins')
      .select('id,name,emoji,price_cents,color_filter')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (myGeneration !== renderGeneration) return;
    if (skinsError || !skins){
      listEl.innerHTML = '';
      statusEl.textContent = 'Unavailable right now.';
      return;
    }

    const { data: owned } = await sb.from('owned_skins').select('skin_id').eq('user_id', session.user.id);
    if (myGeneration !== renderGeneration) return;
    const ownedIds = new Set((owned || []).map(o => o.skin_id));
    const equippedId = profile ? profile.equipped_skin_id : null;

    const mySkins = skins.filter(s => s.price_cents === 0 || ownedIds.has(s.id));

    listEl.innerHTML = '';
    if (mySkins.length === 0){
      listEl.innerHTML = '<p style="color:#9be8ac; font-size:13px;">No skins yet -- check the Shop!</p>';
      return;
    }
    for (const skin of mySkins){
      const equipped = skin.id === equippedId;
      const card = document.createElement('div');
      card.className = 'skinCard' + (equipped ? ' equipped' : '');

      card.innerHTML = `
        <div class="skinEmoji">${escapeHtml(skin.emoji)}</div>
        <div class="skinInfo">
          <div class="skinName">${escapeHtml(skin.name)}</div>
          <div class="skinPrice">${equipped ? 'Equipped' : 'Owned'}</div>
        </div>
      `;
      if (skin.color_filter) card.querySelector('.skinEmoji').style.filter = skin.color_filter;

      const btn = document.createElement('button');
      if (equipped){
        btn.textContent = 'EQUIPPED';
        btn.disabled = true;
      } else {
        btn.textContent = 'EQUIP';
        btn.addEventListener('click', () => equip(skin.id));
      }
      card.appendChild(btn);
      listEl.appendChild(card);
    }
  }

  async function equip(skinId){
    statusEl.textContent = 'Updating…';
    const { error } = await sb.rpc('equip_skin', { p_skin_id: skinId });
    if (error){
      console.error('[myskins] equip_skin failed:', error.message, error);
      statusEl.textContent = "Couldn't equip that skin — try again.";
      return;
    }
    statusEl.textContent = '';
    await auth.refreshProfile(); // equip_skin wrote profiles directly in the DB -- auth's
                                  // cached profile has no other way to learn that
    render();
  }

  return { render };
}
