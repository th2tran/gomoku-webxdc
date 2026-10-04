// Classic-script functions share game.js globals.
function loadGameOptions() {
    let saved;
    try {
        saved = JSON.parse(localStorage.getItem('gomoku-game-options'));
    } catch (err) {
        console.warn('Gomoku: could not load game options', err);
    }
    return {
        sound: typeof saved?.sound === 'boolean' ? saved.sound : true,
        fireworks: typeof saved?.fireworks === 'boolean' ? saved.fireworks : true
    };
}

function initializeGameOptions() {
    const button = document.getElementById('game-options-btn');
    const popup = document.getElementById('game-options-popup');
    const close = document.getElementById('game-options-close-btn');
    const sound = document.getElementById('game-sound-toggle');
    const fireworks = document.getElementById('game-fireworks-toggle');
    const panel = popup.querySelector('[role="dialog"]');
    sound.checked = gameOptions.sound;
    fireworks.checked = gameOptions.fireworks;

    function hide() {
        popup.classList.remove('visible');
        popup.setAttribute('aria-hidden', 'true');
        button.setAttribute('aria-expanded', 'false');
        button.focus();
    }

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        popup.classList.add('visible');
        popup.setAttribute('aria-hidden', 'false');
        button.setAttribute('aria-expanded', 'true');
        sound.focus();
    });
    close.addEventListener('click', hide);
    popup.addEventListener('click', (event) => {
        if (event.target === popup) hide();
    });
    document.addEventListener('keydown', (event) => {
        if (!popup.classList.contains('visible')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            hide();
        } else if (event.key === 'Tab') {
            const controls = Array.from(panel.querySelectorAll('button, input'));
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });

    function save() {
        gameOptions.sound = sound.checked;
        gameOptions.fireworks = fireworks.checked;
        if (gomokuAudioGain) {
            gomokuAudioGain.gain.setValueAtTime(gameOptions.sound ? 1 : 0, gomokuAudioContext.currentTime);
        }
        if (!gameOptions.fireworks) stopFireworks();
        try {
            localStorage.setItem('gomoku-game-options', JSON.stringify(gameOptions));
        } catch (err) {
            console.warn('Gomoku: could not save game options', err);
            showToast('Options changed, but could not be saved on this device.', { variant: 'info' });
        }
    }
    sound.addEventListener('change', save);
    fireworks.addEventListener('change', save);
}
