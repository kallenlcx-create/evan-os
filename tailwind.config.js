/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  safelist: [
    // Card theme backgrounds
    'bg-white', 'border-gray-100',
    'bg-orange-50/60', 'border-orange-100',
    'bg-sky-50/60', 'border-sky-100',
    'bg-emerald-50/60', 'border-emerald-100',
    'bg-purple-50/60', 'border-purple-100',
    'bg-rose-50/60', 'border-rose-100',
    'bg-slate-50/80', 'border-slate-200',
    'bg-amber-50/60', 'border-amber-100',
    // Card theme previews
    'bg-white', 'border-gray-200',
    'bg-orange-50', 'border-orange-200',
    'bg-sky-50', 'border-sky-200',
    'bg-emerald-50', 'border-emerald-200',
    'bg-purple-50', 'border-purple-200',
    'bg-rose-50', 'border-rose-200',
    'bg-slate-50', 'border-slate-300',
    'bg-amber-50', 'border-amber-200',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}