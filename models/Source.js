const mongoose = require('mongoose');

const sourceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  url: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    required: true,
    enum: ['Gündem', 'Ekonomi', 'Spor', 'Siyaset', 'Yaşam', 'Sağlık', 'Son Dakika'],
    default: 'Gündem'
  },
  selectors: {
    articleList: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    image: { type: String, default: '' },
    link: { type: String, required: true },
    category: { type: String, default: '' },
    /** Haber detay sayfasında ana metin kutusu (boşsa otomatik tahmin) */
    content: { type: String, default: '' },
    /** Liste sayfasında "sonraki sayfa" linki (boşsa tek sayfa) */
    paginationNext: { type: String, default: '' }
  },
  baseUrl: {
    type: String,
    default: ''
  },
  active: {
    type: Boolean,
    default: true
  },
  lastScrapedAt: {
    type: Date,
    default: null
  },
  lastScrapedCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Source', sourceSchema);
