# Quick Reference: Spliit & Paperless-AI

## 🎯 Spliit Expense Model (PostgreSQL via Prisma)

### Key Fields for Categorization:
```
Expense {
  id: string              // Unique ID
  title: string           // What to categorize ("Dinner at restaurant", "Gas for car")
  categoryId: int         // Target field (what we update)
  amount: int             // Cost in cents
  notes?: string          // Optional description
  expenseDate: datetime   // When it happened
  paidBy: Participant     // Who paid
  groupId: string         // Group context
}

Category {
  id: int                 // Category ID (1, 2, 3...)
  grouping: string        // Parent grouping ("Food & Dining")
  name: string            // Category name ("Restaurants")
}
```

### Spliit API (tRPC):
```typescript
// Read categories
GET /api/trpc/categories.list
→ { categories: Category[] }

// Read expenses for a group
GET /api/trpc/groups.getExpenses?groupId=xyz
→ { expenses: Expense[] }

// Update expense category
POST /api/trpc/expenses.update
{ expenseId, data: { categoryId: 5 } }
```

### Direct Database (Prisma):
```typescript
import { prisma } from '@/lib/prisma'

// Get all categories
await prisma.category.findMany()

// Get uncategorized expenses
await prisma.expense.findMany({
  where: { categoryId: 0 }
})

// Update expense
await prisma.expense.update({
  where: { id: 'expense123' },
  data: { categoryId: 5 }
})
```

---

## 🤖 Paperless-AI Pattern (Best Practices for Ollama Integration)

### Key Architecture:
```
┌─────────────────────────────────┐
│   Express.js Service            │
├─────────────────────────────────┤
│ 1. Read source (DB/API)         │
│ 2. Build context/prompt         │
│ 3. Call Ollama via axios        │
│ 4. Parse JSON response          │
│ 5. Update target system         │
└─────────────────────────────────┘
        ↓              ↑
   [Ollama API]   [JSON Output]
```

### Ollama Call Pattern:
```javascript
const response = await axios.post(
  'http://localhost:11434/api/generate',
  {
    model: 'mistral',
    prompt: `Categorize: ${expense.title}\n\nReturn JSON: { "categoryId": X, "confidence": 0-1 }`,
    stream: false,
    format: 'json'  // Critical: forces JSON output
  }
)

const result = JSON.parse(response.data.response)
```

### Critical Features:
- ✅ **Factory Pattern**: Switch providers (ollama/openai/azure) via config
- ✅ **Structured Output**: Use `format: 'json'` for reliable parsing
- ✅ **Confidence Scoring**: Always ask for confidence, filter low-confidence results
- ✅ **Batch Processing**: Process in chunks, handle partial failures
- ✅ **Cron Scheduling**: Use node-cron for automated periodic tasks
- ✅ **Manual Interface**: Web UI for user review (playground)
- ✅ **Error Handling**: Graceful degradation, detailed logging

### Config Pattern:
```javascript
// config/config.js
module.exports = {
  aiProvider: process.env.AI_PROVIDER || 'ollama',
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'mistral'
  },
  // ... other providers
}
```

### Service Factory Pattern:
```javascript
class AIServiceFactory {
  static getService() {
    switch (config.aiProvider) {
      case 'ollama': return ollamaService
      case 'openai': return openaiService
      case 'custom': return customService
      default: return openaiService
    }
  }
}
```

---

## 💡 Spliit-AI: Implementation Roadmap

### Phase 1: Database + Service Layer
```javascript
// lib/spliitService.ts
- getUncategorizedExpenses()  // categoryId = 0
- getCategories()
- updateExpenseCategory(id, categoryId)

// services/ollamaService.js
- categorizeExpense(expense, categories)
  → { categoryId, confidence, reasoning }
```

### Phase 2: Scheduler + Main Loop
```javascript
// services/categorizationService.js
async processExpenses() {
  for (const expense of expenses) {
    if (expense.categoryId === 0) {  // Skip already categorized
      const result = await ollama.categorizeExpense(expense, categories)
      if (result.confidence > 0.7) {
        await updateExpenseCategory(expense.id, result.categoryId)
      }
    }
  }
}

// Use node-cron
cron.schedule('0 */4 * * *', () => processExpenses())
```

### Phase 3: Manual Web Interface (Optional)
```javascript
// routes/expenseRoutes.js
POST /api/categorize-expense
  { expenseId, groupId }
  → { suggestedCategoryId, confidence, availableCategories }

POST /api/apply-category
  { expenseId, categoryId }
  → { success: true }
```

### Phase 4: Docker Compose
```yaml
services:
  spliit-ai:
    build: .
    environment:
      POSTGRES_PRISMA_URL: postgresql://...
      OLLAMA_API_URL: http://ollama:11434
      OLLAMA_MODEL: mistral
    depends_on:
      - postgres
      - ollama
```

---

## 🔌 Environment Variables (Spliit-AI)

```env
# PostgreSQL (from Spliit)
POSTGRES_PRISMA_URL=postgresql://user:pass@localhost:5432/spliit
POSTGRES_URL_NON_POOLING=postgresql://user:pass@localhost:5432/spliit

# Ollama
OLLAMA_API_URL=http://localhost:11434
OLLAMA_MODEL=mistral

# Scheduling
SCAN_INTERVAL=0 */4 * * *            # Every 4 hours
MIN_CONFIDENCE_THRESHOLD=0.7

# Optional: Fallback to OpenAI if Ollama fails
AI_PROVIDER=ollama                   # or 'openai'
OPENAI_API_KEY=sk-...                # If using OpenAI fallback

# Logging
LOG_LEVEL=info
```

---

## 📊 Expense Categorization Prompt Example

```
You are an expense categorization AI.

Available categories:
1: Food & Dining > Restaurants
2: Food & Dining > Groceries
3: Transportation > Gas
4: Transportation > Uber/Taxi
5: Entertainment > Movies
6: Shopping > Clothing
7: Utilities > Electricity
... (all categories)

Expense to categorize:
Title: "Whole Foods Grocery Store"
Amount: $85.50
Date: 2024-03-15
Notes: "Weekly groceries, organic produce"
Paid by: "Alice"

Analyze this expense and respond with ONLY valid JSON:
{
  "categoryId": <number>,
  "confidence": <0.0 to 1.0>,
  "reasoning": "<brief explanation>"
}
```

**Expected response:**
```json
{
  "categoryId": 2,
  "confidence": 0.95,
  "reasoning": "Whole Foods is a grocery store, matching 'Food & Dining > Groceries'"
}
```

---

## 🚀 Quick Start (Local Development)

```bash
# 1. Clone Spliit
git clone https://github.com/spliit-app/spliit.git
cd spliit
npm install
docker compose up  # Starts PostgreSQL

# 2. Create spliit-ai service in parallel directory
mkdir ../spliit-ai
cd ../spliit-ai
npm init -y
npm install express axios node-cron dotenv

# 3. Create basic service files
# config/config.js, services/ollamaService.js, server.js (see implementation strategy above)

# 4. Start Ollama (separate terminal)
ollama serve

# 5. Pull a model
ollama pull mistral

# 6. Start spliit-ai service
npm start

# 7. Access Spliit at http://localhost:3000
# Expenses auto-categorization runs on schedule
```

---

## 📚 Key Files to Study

### Spliit:
- `prisma/schema.prisma` - Database schema
- `src/lib/api.ts` - Database access functions
- `src/trpc/routers/categories/` - Category API

### Paperless-AI:
- `config/config.js` - Configuration pattern
- `services/aiServiceFactory.js` - Multi-provider pattern
- `services/ollamaService.js` - Ollama integration
- `server.js` - Main entry point + scheduler

### Spliit-AI (to create):
- `services/expenseCategoryService.js` - AI layer (based on Paperless-AI pattern)
- `lib/spliitService.ts` - Database layer (Prisma client)
- `server.js` - Express + cron scheduler
- `config/config.js` - Environment configuration

---

## ✅ Checklist for Implementation

- [ ] Database connection to Spliit PostgreSQL
- [ ] Prisma client setup for Expense/Category models
- [ ] Ollama API integration (axios client + format: 'json')
- [ ] Prompt engineering for expense categorization
- [ ] JSON response parsing with validation
- [ ] Confidence threshold filtering
- [ ] Database update logic (expense.categoryId)
- [ ] Error handling + logging
- [ ] node-cron scheduler setup
- [ ] Manual "playground" API (optional)
- [ ] Docker Compose file
- [ ] Environment variable documentation
- [ ] Tests (unit + integration)

---

## 💾 Database Quick Reference

### Get uncategorized expenses:
```sql
SELECT * FROM "Expense" 
WHERE "categoryId" = 0 
LIMIT 50;
```

### View available categories:
```sql
SELECT id, grouping, name FROM "Category" 
ORDER BY grouping, name;
```

### Update expense after AI categorization:
```sql
UPDATE "Expense" 
SET "categoryId" = 5 
WHERE id = 'expense123';
```

---

**Next Steps**: Pick a model (mistral, llama2, neural-chat), set up Ollama locally, test the Spliit database connection, and start building the categorization service!
