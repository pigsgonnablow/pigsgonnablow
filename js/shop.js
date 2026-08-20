// Skin shop: browse the `skins` catalog and buy anything not owned yet. Purchasing-only --
// picking which owned skin to wear lives in its own "My Skins" screen (js/myskins.js)
// instead, so a player just choosing an avatar never has to wade through priced items they
// don't own. Buying calls the create-checkout Edge Function (supabase/functions/create-checkout)
// to get a Stripe Checkout URL and redirects the browser there -- the actual grant only ever
// happens server-side, via the stripe-webhook Edge Function, after Stripe confirms payment.
// Like leaderboard.js/auth.js, Supabase is an optional dependency: if it never loaded, the
// shop just says so instead of breaking the game.
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
      .select('id,name,emoji,price_cents,color_filter')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (myGeneration !== renderGeneration) return;

    if (skinsError || !skins){
      listEl.innerHTML = '';
      statusEl.textContent = 'Shop unavailable right now.';
      return;
    }

    const { session } = auth.getState();
    let ownedIds = new Set();
    if (session){
      const { data: owned } = await sb.from('owned_skins').select('skin_id').eq('user_id', session.user.id);
      if (myGeneration !== renderGeneration) return;
      if (owned) ownedIds = new Set(owned.map(o => o.skin_id));
    }

    if (!session){
      statusEl.textContent = 'Sign in from the title screen to buy skins.';
    }

    listEl.innerHTML = '';
    for (const skin of skins){
      const free = skin.price_cents === 0;
      const owned = free || ownedIds.has(skin.id);

      const card = document.createElement('div');
      card.className = 'skinCard';

      const priceText = free ? 'Free' : formatPrice(skin.price_cents);
      // color_filter comes from our own catalog (not user input), but it's still a raw CSS
      // value -- keep it out of the innerHTML template and set it as a real style property
      // instead of string-interpolating it into an attribute.
      card.innerHTML = `
        <div class="skinEmoji">${escapeHtml(skin.emoji)}</div>
        <div class="skinInfo">
          <div class="skinName">${escapeHtml(skin.name)}</div>
          <div class="skinPrice">${owned ? 'Owned' : priceText}</div>
        </div>
      `;
      if (skin.color_filter) card.querySelector('.skinEmoji').style.filter = skin.color_filter;

      const btn = document.createElement('button');
      if (owned){
        btn.textContent = 'OWNED';
        btn.disabled = true;
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
