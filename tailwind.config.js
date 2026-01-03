/** @type {import("tailwindcss").Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans", "Noto Sans", "sans-serif"]
      }
    }
  },
  plugins: []
};
