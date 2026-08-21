# Music slot

`AudioManager` resolves a background track from this directory at **build time**:

```js
import.meta.glob('../assets/audio/music.*', { query: '?url', import: 'default', eager: true })
```

**Nothing ships here.** With no match the glob is empty, `MUSIC_URL` is `null`, and
`#startMusic()` returns before it makes a request — so an absent track costs zero
network calls and produces no console output at all. Everything else you hear —
engine, wind, crash, UI ticks — is synthesised in code and does not touch this file.

## Adding a track

Drop in `music.mp3` (or `.ogg`, `.m4a`, `.wav`, `.flac` — the glob takes any
extension) and rebuild. That is the whole installation step; no code change.

## Why here and not `public/`

`public/` was the first design and was measured out. A runtime probe of a file that
isn't there costs a console error on every load that no application code can suppress:
Chrome logs `Failed to load resource: 404` from the network stack, and Vite's dev
server makes it worse by answering the miss with the SPA fallback (`200 text/html`),
which then fails inside `decodeAudioData`. Resolving at build time makes the absent
case cost nothing, and gets the track content-hashed into the build for free.

## Notes

- The track loops via `AudioBufferSourceNode.loop`, which does not crossfade — trim it
  to a clean loop point.
- The whole file is decoded into memory before it plays. A 3-minute stereo track is
  roughly 30MB of Float32 PCM regardless of its compressed size on disk.
- It plays through the music bus, behind a lowpass the crash sweeps shut and reopens.
