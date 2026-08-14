// Opt-in Supabase-backed leaderboard shown on the game-over screen. Supabase is an
// optional dependency -- if supabase-js failed to load (offline, CDN blocked, etc.)
// this degrades to a disabled leaderboard instead of breaking the game.
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function createLeaderboard({ url, anonKey, elements }){
  const { submitBtn, nameInput, statusEl, listEl, submitBox } = elements;

  let sb = null;
  try {
    if (window.supabase) sb = window.supabase.createClient(url, anonKey);
  } catch (e) { sb = null; }

  let lastFinalScore = 0;
  let alreadySubmitted = false;

  async function render(){
    if (!sb){
      listEl.innerHTML = '<li>Leaderboard unavailable</li>';
      return;
    }
    listEl.innerHTML = '<li>Loading…</li>';
    const { data, error } = await sb
      .from('scores')
      .select('name,score')
      .order('score', { ascending:false })
      .limit(10);
    if (error || !data){
      listEl.innerHTML = '<li>Leaderboard unavailable</li>';
      return;
    }
    if (data.length === 0){
      listEl.innerHTML = '<li>No scores yet — be the first!</li>';
      return;
    }
    listEl.innerHTML = data
      .map(row => `<li>${escapeHtml(row.name)} — ${row.score}</li>`)
      .join('');
  }

  async function submit(name, score){
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
    statusEl.textContent = 'Submitted!';
    submitBox.style.display = 'none';
    render();
  }

  submitBtn.addEventListener('click', () => {
    if (alreadySubmitted) return;
    const name = nameInput.value.trim().slice(0,12);
    if (!name){
      statusEl.textContent = 'Enter a name first.';
      return;
    }
    submit(name, lastFinalScore);
  });

  // Called by the game whenever a run ends, to reset the submit box for the new score.
  function onGameOver(score){
    lastFinalScore = score;
    alreadySubmitted = false;
    submitBox.style.display = '';
    nameInput.value = '';
    statusEl.textContent = '';
    submitBtn.disabled = false;
    render();
  }

  return { onGameOver };
}
