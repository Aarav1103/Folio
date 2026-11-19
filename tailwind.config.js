/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // A phone held sideways: wide, but only about 400px tall. The app then uses
      // a slim icon rail on the left instead of the bottom bar or the full sidebar.
      screens: {
        rail: { raw: '(orientation: landscape) and (max-height: 500px)' },
      },
      colors: {
        parchment: "#F7F5F0",
        ink: "#1A1814",
        "ink-muted": "#6B6560",
        teal: {
          600: "#2D6A5E",
          500: "#3D8A7A",
          100: "#E8F4F1",
        },
        sepia: {
          bg: "#F4ECD8",
          text: "#3B2F20",
        },
      },
      fontFamily: {
        display: ["Playfair Display", "Georgia", "serif"],
        body: ["Inter", "system-ui", "sans-serif"],
        reading: ["Lora", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
}
