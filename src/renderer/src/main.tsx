import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/700-italic.css";
import App from "./App.js";
import "./index.css";

// Load the bundled terminal font before xterm measures cells and caches glyphs.
void Promise.all([
  document.fonts.load('400 13px "JetBrains Mono"'),
  document.fonts.load('italic 400 13px "JetBrains Mono"'),
  document.fonts.load('700 13px "JetBrains Mono"'),
  document.fonts.load('italic 700 13px "JetBrains Mono"'),
]).catch((error) => console.error("Could not load JetBrains Mono:", error)).finally(() => {
  // No StrictMode: its double-mounted effects would spawn duplicate ptys.
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
});
