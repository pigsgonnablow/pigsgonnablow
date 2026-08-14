// Sound effects synthesized via the Web Audio API — no external audio files.
let audioCtx = null;

export function ensureAudio(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  else if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playTone({freq, freqEnd=null, duration=0.15, type='sine', volume=0.25, delay=0}){
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd,1), t0+duration);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0+0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t0+duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0+duration+0.02);
}

function playNoiseBurst({duration=0.3, volume=0.3, filterFreqStart=2000, filterFreqEnd=200, delay=0}){
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + delay;
  const bufferSize = Math.floor(audioCtx.sampleRate * duration);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i=0;i<bufferSize;i++) data[i] = Math.random()*2-1;
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(filterFreqStart, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(filterFreqEnd,20), t0+duration);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0+duration);
  noise.connect(filter).connect(gain).connect(audioCtx.destination);
  noise.start(t0);
  noise.stop(t0+duration+0.02);
}

export function sfxFeed(){ playTone({freq:380, freqEnd:620, duration:0.09, type:'square', volume:0.18}); }
export function sfxThrow(){ playTone({freq:260, freqEnd:520, duration:0.12, type:'sine', volume:0.16}); }
export function sfxJump(){ playTone({freq:180, freqEnd:420, duration:0.3, type:'sawtooth', volume:0.2}); }
export function sfxExplosion(){
  playNoiseBurst({duration:0.4, volume:0.35, filterFreqStart:3000, filterFreqEnd:150});
  playTone({freq:90, freqEnd:40, duration:0.35, type:'sine', volume:0.3});
}
export function sfxCoin(){
  playTone({freq:880, duration:0.09, type:'square', volume:0.15});
  playTone({freq:1318.5, duration:0.12, type:'square', volume:0.15, delay:0.06});
}
export function sfxHit(){ playTone({freq:220, freqEnd:80, duration:0.25, type:'sawtooth', volume:0.25}); }
export function sfxBonus(){
  playTone({freq:523.25, duration:0.1, type:'triangle', volume:0.2});
  playTone({freq:659.25, duration:0.1, type:'triangle', volume:0.2, delay:0.08});
  playTone({freq:783.99, duration:0.16, type:'triangle', volume:0.22, delay:0.16});
}
export function sfxGameOver(){ playTone({freq:300, freqEnd:80, duration:0.6, type:'square', volume:0.25}); }

export function sfxOink(){
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  function oinkBurst(delay, freqStart, freqEnd, dur){
    const t = t0 + delay;
    const osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, t+dur);
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(500, t);
    filter.Q.setValueAtTime(3, t);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3, t+0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t+dur);
    osc.connect(filter).connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t+dur+0.02);
  }
  oinkBurst(0, 340, 200, 0.13);
  oinkBurst(0.16, 320, 190, 0.15);
}

export function sfxRoar(){
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const dur = 1.1;

  // low growl: two detuned sawtooth oscillators, pitch dropping over time, with vibrato
  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  osc1.type = 'sawtooth'; osc2.type = 'sawtooth';
  osc1.frequency.setValueAtTime(85, t0);
  osc2.frequency.setValueAtTime(90, t0);
  osc1.frequency.exponentialRampToValueAtTime(58, t0+dur);
  osc2.frequency.exponentialRampToValueAtTime(63, t0+dur);

  const lfo = audioCtx.createOscillator();
  lfo.frequency.setValueAtTime(7, t0);
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.setValueAtTime(8, t0); // vibrato depth, Hz
  lfo.connect(lfoGain);
  lfoGain.connect(osc1.frequency);
  lfoGain.connect(osc2.frequency);

  const growlFilter = audioCtx.createBiquadFilter();
  growlFilter.type = 'lowpass';
  growlFilter.frequency.setValueAtTime(1200, t0);
  growlFilter.frequency.exponentialRampToValueAtTime(300, t0+dur);

  const growlGain = audioCtx.createGain();
  growlGain.gain.setValueAtTime(0, t0);
  growlGain.gain.linearRampToValueAtTime(0.32, t0+0.15);
  growlGain.gain.linearRampToValueAtTime(0.22, t0+dur*0.6);
  growlGain.gain.exponentialRampToValueAtTime(0.001, t0+dur);

  osc1.connect(growlFilter);
  osc2.connect(growlFilter);
  growlFilter.connect(growlGain).connect(audioCtx.destination);
  osc1.start(t0); osc2.start(t0); lfo.start(t0);
  osc1.stop(t0+dur+0.05); osc2.stop(t0+dur+0.05); lfo.stop(t0+dur+0.05);

  // breathy noise layer for texture
  const bufferSize = Math.floor(audioCtx.sampleRate * dur);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i=0;i<bufferSize;i++) data[i] = Math.random()*2-1;
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.setValueAtTime(900, t0);
  noiseFilter.Q.setValueAtTime(0.7, t0);
  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(0, t0);
  noiseGain.gain.linearRampToValueAtTime(0.15, t0+0.2);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t0+dur);
  noise.connect(noiseFilter).connect(noiseGain).connect(audioCtx.destination);
  noise.start(t0);
  noise.stop(t0+dur+0.05);
}
