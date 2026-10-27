import type { NativeScene } from './runtime-types.js';
export function trailerEntry({ scripts, boot }: {
    scripts: string;
    boot: string;
}) {
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + PLAYER_STYLE + '</style></head><body><main><canvas></canvas><div class="preparing" role="status"><span>PREPARING</span><progress max="1" value="0"></progress></div></main><footer><button data-trailer-play disabled aria-label="Play">Play</button><input data-trailer-seek type="range" min="0" max="60" step="0.01" value="0" aria-label="Trailer position" disabled><output>Preparing scene…</output><button data-trailer-sound aria-label="Mute" disabled>Sound</button><button data-trailer-save disabled>Save MP4</button></footer>' + scripts + '<script>' + boot + '</script></body></html>';
}
const PLAYER_STYLE = `*{box-sizing:border-box}html,body{margin:0;background:#080a12;color:#f4f6ff;height:100%;font:12px ui-monospace,monospace}body{display:flex;flex-direction:column}main{position:relative;display:flex;align-items:center;justify-content:center;flex:1;min-height:0;overflow:hidden}main>canvas,main>video{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}footer{display:flex;align-items:center;gap:12px;padding:12px 16px;min-height:58px;background:#10121e;border-top:1px solid #292b42}button{font:inherit;color:inherit;background:#181c2d;border:1px solid #343951;border-radius:6px;min-height:34px;padding:8px 12px;cursor:pointer;white-space:nowrap}button:hover:not(:disabled){border-color:#56e2ef;background:#22293d}button:focus-visible,input:focus-visible{outline:2px solid #56e2ef;outline-offset:3px}button:disabled{opacity:.42;cursor:default}[data-trailer-play]{background:#183441;border-color:#56e2ef;color:#f4f6ff;min-width:76px}[data-trailer-seek]{min-width:60px;flex:1;accent-color:#56e2ef;cursor:pointer}output{min-width:105px;white-space:nowrap;color:#b4bbce}.preparing{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#080a12}.preparing[hidden]{display:none}.preparing progress{width:min(240px,60%);height:4px;accent-color:#56e2ef}.pixel-label{image-rendering:pixelated;height:24px;vertical-align:middle;max-width:100%}.label-accessible{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@media(max-width:600px){footer{flex-wrap:wrap;gap:8px;padding:10px}output{margin-left:auto} [data-trailer-seek]{order:5;flex-basis:100%}[data-trailer-save]{margin-left:auto}}`;
export function attachPlayerUI({ scene, duration, onPlay, onSeek, onSound, onSave }: {
    scene: NativeScene;
    duration: number;
    onPlay: () => void;
    onSeek: (time: number) => void;
    onSound: () => void;
    onSave: () => void;
}) {
    const button = document.querySelector<HTMLButtonElement>('[data-trailer-play]') ?? document.querySelector<HTMLButtonElement>('button')!, status = document.querySelector<HTMLOutputElement>('output')!, seek = document.querySelector<HTMLInputElement>('[data-trailer-seek]'), sound = document.querySelector<HTMLButtonElement>('[data-trailer-sound]'), save = document.querySelector<HTMLButtonElement>('[data-trailer-save]'), loader = document.querySelector<HTMLElement>('.preparing');
    const label = (el: HTMLElement | null, value: string) => {
        if (!el || el.dataset.label === value)
            return;
        el.dataset.label = value;
        el.setAttribute('aria-label', value);
        el.textContent = value;
        if (scene.playerLabel) {
            const canvas = document.createElement('img');
            canvas.src = scene.playerLabel(value).toDataURL();
            canvas.alt = '';
            canvas.className = 'pixel-label';
            const text = document.createElement('span');
            text.className = 'label-accessible';
            text.textContent = value;
            el.replaceChildren(canvas, text);
        }
    };
    button.onclick = onPlay;
    if (seek) {
        seek.max = String(duration);
        seek.oninput = () => onSeek(Number(seek.value));
    }
    if (sound)
        sound.onclick = onSound;
    if (save)
        save.onclick = onSave;
    return { button, status, prepare(value: number, text: string) { if (loader) {
            loader.querySelector<HTMLProgressElement>('progress')!.value = value;
            label(loader.querySelector<HTMLSpanElement>('span'), text);
        } status.textContent = text; }, ready() { loader?.setAttribute('hidden', ''); button.disabled = false; if (seek)
            seek.disabled = false; if (sound)
            sound.disabled = false; }, update({ playing, time, muted, media, progress = 0, hasSound, encodeError }: {
            playing: boolean;
            time: number;
            muted: boolean;
            media: string;
            progress?: number;
            hasSound: boolean;
            encodeError?: string | null;
        }) { label(button, playing && hasSound ? 'Pause' : 'Play'); if (seek && document.activeElement !== seek)
            seek.value = String(time); label(sound, !hasSound ? 'Enable sound' : muted ? 'Muted' : 'Sound'); label(save, media === 'encoding' ? 'MP4 ' + Math.round(progress * 100) + '%' : media === 'error' ? 'MP4 unavailable' : 'Save MP4'); if (save)
            save.disabled = media !== 'mp4'; label(status, time.toFixed(1) + ' / ' + duration.toFixed(1)); button.setAttribute('aria-pressed', String(playing && hasSound)); if (sound)
            sound.setAttribute('aria-pressed', String(hasSound && !muted)); if (save)
            save.title = media === 'mp4' ? 'Save the generated MP4' : media === 'encoding' ? 'Encoding ' + Math.round(progress * 100) + '%' : encodeError || 'MP4 is generated automatically in the background'; }, encoding(state: string, progress: number) { if (save) {
            save.dataset.state = state;
            save.title = state === 'encoding' ? 'Encoding ' + Math.round(progress * 100) + '%' : state === 'waiting' ? 'Waiting for the next full playback pass' : 'Save the generated MP4';
        } } };
}
