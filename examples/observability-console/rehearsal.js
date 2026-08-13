/* ─────────────────────────────────────────────────────────────────────────────
   Rehearsal input — a scripted microphone.

   Filming a take shouldn't depend on saying the same three sentences the same way
   twice, and a test gate shouldn't need a permanent microphone grant on somebody's
   laptop. So this replaces `getUserMedia` with a real MediaStream fed from audio
   files on a schedule: same WebRTC path, same server-side VAD and ASR, same events —
   the only thing that changed is where the sound came from.

   It is deliberately NOT a mock. Nothing downstream of the track knows about it, and
   every number the console then measures is a real round-trip to the platform.

       ?rehearse=rehearsal.json      run the script in that file
       ?rehearse=1                   run ./rehearsal.json

   The script is a list of cues:

       { "cues": [ { "at": 1500, "file": "r1.wav" }, { "at": 14000, "file": "r2.wav" } ] }

   `at` is milliseconds after the session opens. Generate the files with anything that
   writes a wav — on macOS, `say -o r1.wav --data-format=LEI16@22050 "…"`.
   ──────────────────────────────────────────────────────────────────────────── */

export async function installRehearsal(scriptUrl) {
  const script = await fetch(scriptUrl).then((r) => r.json());
  const cues = (script.cues ?? []).slice().sort((a, b) => a.at - b.at);
  if (!cues.length) throw new Error("Rehearsal script has no cues.");

  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  await ctx.resume();
  const dest = ctx.createMediaStreamDestination();

  // A whisper of noise under everything. Some VADs and AGC paths treat a
  // mathematically silent track as a dead device, and a dead device is exactly the
  // failure this harness must not fake its way past.
  const floor = ctx.createBufferSource();
  const noise = ctx.createBuffer(1, 48000, 48000);
  const ch = noise.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() - 0.5) * 2e-4;
  floor.buffer = noise;
  floor.loop = true;
  const floorGain = ctx.createGain();
  floorGain.gain.value = 1;
  floor.connect(floorGain).connect(dest);
  floor.start();

  const buffers = await Promise.all(
    cues.map((c) =>
      fetch(new URL(c.file, new URL(scriptUrl, location.href)))
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b)),
    ),
  );

  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const track = dest.stream.getAudioTracks()[0];
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints?.audio) return original(constraints);
    // A CLONE per call, not the stream itself. The SDK's microphone preflight opens a
    // stream, judges it, and stops every track on it (src/mic.ts) — handing out the one
    // real track would leave the session connected to a microphone that had already
    // been stopped, which is exactly the deaf session the preflight exists to prevent.
    return dest.stream.clone();
  };

  return {
    track,
    /** Start the script. `t0` is the console's own clock origin. */
    play(onCue) {
      cues.forEach((c, i) => {
        setTimeout(() => {
          const src = ctx.createBufferSource();
          src.buffer = buffers[i];
          src.connect(dest);
          src.start();
          onCue?.(c, buffers[i].duration * 1000);
        }, c.at);
      });
      return cues[cues.length - 1].at + buffers[buffers.length - 1].duration * 1000;
    },
    restore() {
      navigator.mediaDevices.getUserMedia = original;
      try { floor.stop(); ctx.close(); } catch {}
    },
  };
}
