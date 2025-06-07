// Test script to verify QJSXPATH module resolution
import { add, multiply, factorial, PI } from "math";
import { capitalize, reverse, randomInt } from "utils";

console.log("=== QJSXPATH Module Resolution Test ===");
console.log("");

// Test math module
console.log("Testing math module:");
console.log(`add(5, 3) = ${add(5, 3)}`);
console.log(`multiply(4, 7) = ${multiply(4, 7)}`);
console.log(`factorial(5) = ${factorial(5)}`);
console.log(`PI = ${PI}`);
console.log("");

// Test utils module
console.log("Testing utils module:");
console.log(`capitalize("hello") = ${capitalize("hello")}`);
console.log(`reverse("world") = ${reverse("world")}`);
console.log(`randomInt(1, 10) = ${randomInt(1, 10)}`);
console.log("");

console.log("✅ All QJSXPATH imports successful!");
console.log("This demonstrates Node.js-style bare module imports working in QuickJS!");