// Skin shop: browse the `skins` catalog, see what's owned, and equip anything owned (or
// free) via the equip_skin RPC. Buying a priced skin calls the create-checkout Edge Function
// (supabase/functions/create-checkout) to get a Stripe Checkout URL and redirects the browser
// there -- the actual grant only ever happens server-side, via the stripe-webhook Edge
// Function, after Stripe confirms payment. Like leaderboard.js/auth.js, Supabase is an
// optional dependency: if it never loaded, the shop just says so instead of breaking the game.
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatPrice(cents){
  return '$' + (cents / 100).toFixed(2);
}

export function createShop({ auth, elements }){
  const { listEl, statusEl } = elements;
  const sb = auth ? auth.getClient() : null;

  let renderGeneration = 0;

  async function render(){
    const myGeneration = ++renderGeneration;
    if (!sb){
      listEl.innerHTML = '';
      statusEl.textContent = 'Shop unavailable right now.';
      return;
    }
    listEl.innerHTML = '<p style="color:#9be8ac; font-size:13px;">Loading…</p>';
    statusEl.textContent = '';

    const { data: skins, error: skinsError } = await sb
      .from('skins')
      .select('id,name,emoji,price_cents')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (myGeneration !== renderGeneration) return;

    if (skinsError || !skins){
      listEl.innerHTML = '';
      statusEl.textContent = 'Shop unavailable right now.';
      return;
    }

    const { session, profile } = auth.getState();
    let ownedIds = new Set();
    if (session){
      const { data: owned } = await sb.from('owned_skins').select('skin_id').eq('user_id', session.user.id);
      if (myGeneration !== renderGeneration) return;
      if (owned) ownedIds = new Set(owned.map(o => o.skin_id));
    }
    const equippedId = profile ? profile.equipped_skin_id : null;

    if (!session){
      statusEl.textContent = 'Sign in from the title screen to buy or equip skins.';
    }

    listEl.innerHTML = '';
    for (const skin of skins){
      const free = skin.price_cents === 0;
      const owned = free || ownedIds.has(skin.id);
      const equipped = skin.id === equippedId;

      const card = document.createElement('div');
      card.className = 'skinCard' + (equipped ? ' equipped' : '');

      const priceText = free ? 'Free' : formatPrice(skin.price_cents);
      card.innerHTML = `
        <div class="skinEmoji">${escapeHtml(skin.emoji)}</div>
        <div class="skinInfo">
          <div class="skinName">${escapeHtml(skin.name)}</div>
          <div class="skinPrice">${equipped ? 'Equipped' : (owned ? 'Owned' : priceText)}</div>
        </div>
      `;

      const btn = document.createElement('button');
      if (equipped){
        btn.textContent = 'EQUIPPED';
        btn.disabled = true;
      } else if (owned){
        btn.textContent = 'EQUIP';
        btn.disabled = !session;
        btn.addEventListener('click', () => equip(skin.id));
      } else {
        btn.textContent = 'BUY';
        btn.classList.add('buy');
        btn.disabled = !session;
        if (!session) btn.title = 'Sign in to buy';
        btn.addEventListener('click', () => buy(skin.id, btn));
      }
      card.appendChild(btn);
      listEl.appendChild(card);
    }
  }

  async function equip(skinId){
    statusEl.textContent = 'Updating…';
    const { error } = await sb.rpc('equip_skin', { p_skin_id: skinId });
    if (error){
      console.error('[shop] equip_skin failed:', error.message, error);
      statusEl.textContent = "Couldn't equip that skin — try again.";
      return;
    }
    statusEl.textContent = '';
    await auth.refreshProfile(); // equip_skin wrote profiles.equipped_skin_id directly in the
                                  // DB -- auth's cached profile has no other way to learn that
    render();
  }

  async function buy(skinId, btn){
    btn.disabled = true;
    statusEl.textContent = 'Redirecting to checkout…';
    // sb.functions.invoke automatically attaches the caller's Supabase session as an
    // Authorization bearer token -- that's what create-checkout uses server-side to identify
    // the buyer, instead of trusting a user_id the client could otherwise lie about.
    const { data, error } = await sb.functions.invoke('create-checkout', { body: { skin_id: skinId } });
    if (error || !data?.url){
      console.error('[shop] create-checkout failed:', error, data);
      statusEl.textContent = "Couldn't start checkout — try again.";
      btn.disabled = false;
      return;
    }
    window.location.href = data.url;
  }

  return { render };
}
