// Math utilities module
export function add(a, b) {
    return a + b;
}

export function multiply(a, b) {
    return a * b;
}

export function factorial(n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}

export const PI = 3.14159265359;

console.log("Math module loaded");