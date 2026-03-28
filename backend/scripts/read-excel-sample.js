/**
 * Выводит структуру листа Excel для анализа.
 * Запуск: node scripts/read-excel-sample.js
 */
const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, '../../2025.12.15. Бланк отчета - кофе.xlsx');
const workbook = XLSX.readFile(filePath);

console.log('Листы:', workbook.SheetNames);
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
console.log('Диапазон:', sheet['!ref']);
console.log('Строк:', range.e.r - range.s.r + 1, 'Колонок:', range.e.c - range.s.c + 1);
console.log('\nДанные (массив массивов):');
const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
data.slice(0, 25).forEach((row, i) => console.log(i + 1, JSON.stringify(row)));
console.log('\nМержи (если есть):', sheet['!merges'] || []);
