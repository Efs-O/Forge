let scoreSpan = null;
let speedSpan = null;
let overlay = null;

/**
 * Caches references to the HUD spans and the game-over overlay.
 * Sets initial values and hides the overlay.
 */
export function initUI() {
    scoreSpan = document.getElementById('score');
    speedSpan = document.getElementById('speed');
    overlay = document.getElementById('overlay');

    if (scoreSpan) scoreSpan.innerText = '0';
    if (speedSpan) speedSpan.innerText = '0';
    if (overlay) overlay.style.display = 'none';
}

/**
 * Updates the HUD with the current score and speed.
 * @param {number} score - Integer seconds survived.
 * @param {number} speed - Current asteroid speed.
 */
export function updateHUD(score, speed) {
    if (scoreSpan) {
        scoreSpan.innerText = score;
    }
    if (speedSpan) {
        speedSpan.innerText = speed.toFixed(1);
    }
}

/**
 * Displays the game-over overlay with the final score.
 * @param {number} finalScore - The score achieved before collision.
 */
export function showGameOver(finalScore) {
    if (overlay) {
        overlay.innerHTML = `
            <div style="text-align: center; color: white; font-family: sans-serif;">
                <h1>Game Over</h1>
                <p>Final Score: ${finalScore}</p>
                <p>Click to restart</p>
            </div>
        `;
        overlay.style.display = 'flex';
    }
}

/**
 * Hides the game-over overlay.
 */
export function hideOverlay() {
    if (overlay) {
        overlay.style.display = 'none';
    }
}
