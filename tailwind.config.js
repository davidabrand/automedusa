/** @type {import('tailwindcss').Config} */
// Apple-style dark palette. Remapping Tailwind's palettes keeps every utility class
// but moves the whole app onto iOS system colors: neutral grays, one blue tint,
// and green / red / orange only for meaning.
export default {
    content: ['./index.html', './src/**/*.js'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"SF Pro Display"', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif']
            },
            colors: {
                slate: {
                    50: '#F9F9FB', 100: '#F2F2F7', 200: '#E5E5EA', 300: '#D1D1D6',
                    400: '#AEAEB2', 500: '#8E8E93', 600: '#636366', 700: '#3A3A3C',
                    800: '#2C2C2E', 900: '#1C1C1E', 950: '#000000'
                },
                blue: {
                    300: '#70B7FF', 400: '#409CFF', 500: '#3395FF',
                    600: '#0A84FF', 700: '#0071E3', 950: '#001A33'
                },
                emerald: {
                    300: '#6EE591', 400: '#30D158', 500: '#30D158',
                    600: '#248A3D', 950: '#0B2B14'
                },
                rose: {
                    300: '#FF8A80', 400: '#FF453A', 500: '#FF453A',
                    600: '#D70015', 700: '#B0000F', 950: '#330604'
                },
                amber: {
                    400: '#FF9F0A', 500: '#FF9F0A', 600: '#C93400'
                }
            }
        }
    }
};
