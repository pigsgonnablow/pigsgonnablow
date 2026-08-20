// Opt-in Supabase-backed leaderboard shown on the game-over screen. Supabase is an
// optional dependency -- if supabase-js failed to load (offline, CDN blocked, etc.)
// this degrades to a disabled leaderboard instead of breaking the game.
//
// Two submission paths:
//  - Signed in (auth has a session + profile): score is auto-submitted as that account's
//    personal best via the submit_personal_best RPC -- no typing, no duplicate rows, and
//    a later lower score never overwrites a higher one (enforced server-side).
//  - Anonymous: unchanged opt-in flow -- type a name, submit, one row per run.
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function createLeaderboard({ url, anonKey, auth, elements }){
  const { submitBtn, nameInput, statusEl, listEl, submitBox } = elements;

  // Reuse auth's Supabase client rather than creating a second one -- two separate
  // clients in the same tab both manage the same auth session independently, which
  // causes Supabase's "Multiple GoTrueClient instances" warning and, worse, submit
  // calls silently running without the signed-in session the other client holds.
  let sb = null;
  if (auth){
    sb = auth.getClient();
  } else {
    try {
      if (window.supabase) sb = window.supabase.createClient(url, anonKey);
    } catch (e) { sb = null; }
  }

  let lastFinalScore = 0;
  let alreadySubmitted = false;
  let justSubmittedName = null;

  // onGameOver's initial render() and the post-submit render() can both be in flight at
  // once; a generation token lets a slow, stale response lose to a newer one instead of
  // overwriting the just-submitted score back out of the list.
  let renderGeneration = 0;

  // Shared by the game-over board and the standalone preview opened from the start screen
  // (see renderInto below) -- both just need the same fetch/highlight logic pointed at a
  // different <ol>.
  async function renderInto(targetEl){
    const myGeneration = ++renderGeneration;
    if (!sb){
      targetEl.innerHTML = '<li>Leaderboard unavailable</li>';
      return;
    }
    targetEl.innerHTML = '<li>Loading…</li>';
    const { data, error } = await sb
      .from('scores')
      .select('user_id,name,score,avatar,color_filter')
      .order('score', { ascending:false })
      .limit(10);
    if (myGeneration !== renderGeneration) return; // a newer render() superseded this one
    if (error || !data){
      targetEl.innerHTML = '<li>Leaderboard unavailable</li>';
      return;
    }
    if (data.length === 0){
      targetEl.innerHTML = '<li>No scores yet — be the first!</li>';
      return;
    }
    const { session } = auth ? auth.getState() : { session: null };
    targetEl.innerHTML = data
      .map(row => {
        const mine = session
          ? row.user_id === session.user.id
          : (justSubmittedName && row.name === justSubmittedName && row.score === lastFinalScore);
        // color_filter (from our own catalog via scores, not user input) recolors skins like
        // the red dragon that reuse the base glyph -- see supabase_skin_color_filter_schema.sql.
        // Without it a colored skin would look identical to the default on the leaderboard.
        const avatarStyle = row.color_filter ? ` style="filter:${row.color_filter}"` : '';
        const avatar = row.avatar ? `<span${avatarStyle}>${escapeHtml(row.avatar)}</span> ` : '';
        const text = `${avatar}${escapeHtml(row.name)} — ${row.score}`;
        return mine ? `<li><strong>${text} (you!)</strong></li>` : `<li>${text}</li>`;
      })
      .join('');
  }

  function render(){ return renderInto(listEl); }

  async function submitAnonymous(name, score){
    if (!sb){
      statusEl.textContent = 'Leaderboard unavailable right now.';
      return;
    }
    submitBtn.disabled = true;
    statusEl.textContent = 'Submitting…';
    const { error } = await sb.from('scores').insert({ name, score });
    if (error){
      statusEl.textContent = "Couldn't submit — try again.";
      submitBtn.disabled = false;
      return;
    }
    alreadySubmitted = true;
    justSubmittedName = name;
    statusEl.textContent = 'Submitted!';
    submitBox.style.display = 'none';
    render();
  }

  async function submitSignedIn(score){
    submitBox.style.display = 'none';
    statusEl.textContent = 'Submitting…';
    const { data, error } = await sb.rpc('submit_personal_best', { p_score: score });
    if (error){
      console.error('[leaderboard] submit_personal_best failed:', error.message, error);
      statusEl.textContent = "Couldn't submit — try again.";
      render(); // still show the current board even though this run's score didn't make it in
      return;
    }
    alreadySubmitted = true;
    statusEl.textContent = (data != null) ? 'New personal best!' : "Didn't beat your personal best — still on the board!";
    render();
  }

  submitBtn.addEventListener('click', () => {
    if (alreadySubmitted) return;
    const name = nameInput.value.trim().slice(0,12);
    if (!name){ statusEl.textContent = 'Enter a name first.'; return; }
    submitAnonymous(name, lastFinalScore);
  });

  // Called by the game whenever a run ends, to reset the submit box for the new score.
  function onGameOver(score){
    lastFinalScore = score;
    alreadySubmitted = false;
    justSubmittedName = null;
    statusEl.textContent = '';
    submitBtn.disabled = false;

    const { session, profile } = auth ? auth.getState() : { session: null, profile: null };
    if (session && profile){
      submitBox.style.display = 'none';
      render(); // show the current board right away; submitSignedIn() re-renders once it resolves
      submitSignedIn(score);
    } else {
      submitBox.style.display = session ? 'none' : ''; // signed in but no profile yet: hide, account widget handles setup
      nameInput.value = '';
      render();
    }
  }

  return { onGameOver, render, renderInto };
}
