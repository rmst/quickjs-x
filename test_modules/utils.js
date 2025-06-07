// Utility functions module (utils.js format)
export function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function reverse(str) {
    return str.split('').reverse().join('');
}

export function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

console.log("Utils module loaded");