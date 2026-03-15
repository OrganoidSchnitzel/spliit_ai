# PROJECT ANALYSIS: Spliit & Paperless-AI Integration Guide

## 1. SPLIIT - BILL SPLITTING WEB APP

### Architecture
- **Framework**: Next.js 16+ (React 19)
- **API Pattern**: tRPC (Type-safe RPC framework)
- **Database**: PostgreSQL with Prisma ORM
- **Runtime**: Node.js
- **Language**: TypeScript/React
- **Build Tool**: Next.js built-in
- **Styling**: Tailwind CSS + Radix UI components

### Database Schema (PostgreSQL)

#### **Expense Model** - Core entity for categorization:
```
Expense {
  id: String (UUID)
  title: String                    // Expense description
  categoryId: Int                  // Foreign key to Category
  category: Category?              // Relation
  amount: Int                      // Amount in cents
  originalAmount: Int?             // Original amount before currency conversion
  originalCurrency: String?        // ISO currency code
  conversionRate: Decimal?         // Exchange rate used
  
  expenseDate: DateTime            // When expense occurred
  createdAt: DateTime              // When created in system
  
  paidBy: Participant              // Who paid
  paidById: String
  
  paidFor: ExpensePaidFor[]        // Who benefited (split logic)
  
  groupId: String                  // Group association
  group: Group
  
  // Additional metadata
  isReimbursement: Boolean (default: false)
  splitMode: SplitMode enum       // EVENLY | BY_SHARES | BY_PERCENTAGE | BY_AMOUNT
  notes: String?                   // Additional notes/description
  
  // Documents/attachments
  documents: ExpenseDocument[]     // Receipts, images
  
  // Recurring support
  recurrenceRule: RecurrenceRule?  // NONE | DAILY | WEEKLY | MONTHLY
  recurringExpenseLink: RecurringExpenseLink?
}
```

#### **Category Model** - For expense categorization:
```
Category {
  id: Int (auto-increment)
  grouping: String                 // Category grouping/parent
  name: String                     // Category name (e.g., "Food", "Transport")
  Expense: Expense[]               // Relations to expenses
}
```

#### **Available Expense Fields for Categorization**:
- `title` - Text description of expense
- `amount` - Numerical value
- `notes` - Free text notes
- `categoryId` - Current category ID
- `expenseDate` - Date of expense
- All participant/group context

### API Access Methods

**Method 1: tRPC Queries** (Client-side)
```typescript
// Server: /src/trpc/routers/categories/list.procedure.ts
import { getCategories } from '@/lib/api'
export const listCategoriesProcedure = baseProcedure.query(async () => {
  return { categories: await getCategories() }
})

// Client usage (from browser)
const { categories } = await trpc.categories.list.query()
```

**Method 2: Direct Database Access**
```typescript
// /src/lib/api.ts - Direct Prisma queries
export async function getCategories() {
  return prisma.category.findMany()
}

export async function getGroupExpenses(groupId: string) {
  return prisma.expense.findMany({
    where: { groupId },
    include: {
      category: true,
      paidBy: { select: { id: true, name: true } },
      paidFor: { select: { ... } },
      // etc
    }
  })
}

// Update expense category
export async function updateExpense(groupId: string, expenseId: string, data: {categoryId: number}) {
  await prisma.expense.update({
    where: { id: expenseId },
    data: { categoryId: data.categoryId }
  })
}
```

### Predefined Categories
Spliit ships with standard categories (from seed data):
- Food & Dining
- Transportation
- Entertainment
- Shopping
- Utilities
- Health & Fitness
- Travel
- Personal Care
- Gifts & Donations
- Other

Each with a `grouping` field for UI organization.

### Key API Endpoints (tRPC routes)
- `GET /api/trpc/categories.list` - List all categories
- `GET /api/trpc/groups.getExpenses` - Get group expenses
- `POST /api/trpc/expenses.update` - Update expense data (including category)

---

## 2. PAPERLESS-AI - AI DOCUMENT PROCESSING FOR PAPERLESS-NGX

### Architecture
- **Framework**: Express.js 4.21+
- **Database**: SQLite3 (better-sqlite3) for local state + Paperless-ngx PostgreSQL
- **Runtime**: Node.js
- **Language**: JavaScript (CommonJS)
- **LLM Integration**: Multi-provider factory pattern
- **Frontend**: EJS templates
- **RAG**: Python FastAPI service (separate container)

### Tech Stack Dependencies
```json
{
  "express": "^4.21.2",                // REST API server
  "node-cron": "^3.0.3",              // Scheduled tasks
  "openai": "^4.86.2",                // OpenAI SDK (compatible with Ollama)
  "better-sqlite3": "^11.8.1",        // Local database
  "axios": "^1.8.2",                  // HTTP requests
  "cheerio": "^1.0.0",                // HTML parsing for document text
  "dotenv": "^16.4.7",                // Environment config
  "bcryptjs": "^3.0.2"                // API authentication
}
```

### Ollama Integration Pattern

**Service Factory Pattern** (`services/aiServiceFactory.js`):
```javascript
class AIServiceFactory {
  static getService() {
    switch (config.aiProvider) {
      case 'ollama':
        return ollamaService;
      case 'openai':
      default:
        return openaiService;
      case 'custom':
        return customService;
      case 'azure':
        return azureService;
    }
  }
}
```

**Ollama Service** (`services/ollamaService.js`):
```javascript
const config = require('../config/config');

class OllamaService {
  constructor() {
    this.apiUrl = config.ollama.apiUrl;        // Default: http://localhost:11434
    this.model = config.ollama.model;          // Default: llama3.2
    this.client = axios.create({
      timeout: 1800000  // 30 minutes for long operations
    });
  }

  async analyzeDocument(content, existingTags, existingCorrespondents, ...) {
    // Truncate content to token limits
    // Build structured prompt
    // Call: POST http://localhost:11434/api/generate
    // Parse JSON response with structured output
  }
}
```

**Configuration** (`config/config.js`):
```javascript
ollama: {
  apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'llama3.2'
}

aiProvider: process.env.AI_PROVIDER || 'openai'  // Switch provider via env
```

### Key Features & Architecture

#### 1. **Automated Document Processing**
- Cron-based scanning: `node-cron` with configurable intervals
- Hooks into Paperless-ngx webhook API
- Retrieves document content, parses text
- Sends to LLM for analysis
- Updates Paperless-ngx via API (tags, title, correspondent, document type)

#### 2. **Manual Processing / "Playground" Feature**
- Web interface for manual AI tagging
- User submits document/text → AI analyzes
- Shows proposed tags, title, correspondent
- User can accept/modify before saving to Paperless-ngx
- Useful for sensitive documents or testing

#### 3. **Output Schema (Structured)**
```javascript
{
  title: "string",                    // Document title
  correspondent: "string",            // Sender/correspondent
  tags: ["tag1", "tag2", ...],       // Array of tags
  document_type: "string",            // Invoice, Contract, etc.
  document_date: "YYYY-MM-DD",       // Date of document
  language: "en/de/es/...",          // Detected language
  custom_fields: {                    // Optional custom fields
    field_name: "value"
  }
}
```

#### 4. **Restriction Features**
Paperless-AI can restrict AI output to:
- Existing tags (from Paperless-ngx database)
- Existing correspondents
- Existing document types
- Via prompt engineering + JSON schema validation

#### 5. **External API Integration**
- Can fetch additional context from external APIs
- Configurable via environment variables
- Injects data into prompt for enriched analysis

---

## 3. SPLIIT-AI INTEGRATION DESIGN

### Architecture Pattern: Spliit + Ollama

**Goal**: Read Spliit expenses from PostgreSQL, use Ollama to auto-categorize, update categoryId

### Approach (Similar to Paperless-AI)

```
┌─────────────────────────────────────┐
│  Spliit-AI Service (Node.js)        │
│                                     │
│  1. Read Spliit Database            │
│     - Query expenses with categoryId=0
│     - Get all categories for mapping │
│                                     │
│  2. Build Context                   │
│     - Expense title, amount, date   │
│     - Notes, group context          │
│                                     │
│  3. Call Ollama                     │
│     - POST http://localhost:11434   │
│     - Prompt: "Categorize expense"  │
│     - Request JSON output           │
│                                     │
│  4. Parse & Update                  │
│     - Update expense.categoryId      │
│     - Log activity                  │
└─────────────────────────────────────┘
        ↓                       ↑
    PostgreSQL          Expense Updates
        ↓                       ↑
   Spliit DB ←──────────────────┘
```

### Implementation Strategy

#### **1. Configuration**
```javascript
// config/config.js
module.exports = {
  spliit: {
    database: process.env.POSTGRES_URL,  // PostgreSQL connection
  },
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'mistral'
  },
  scanInterval: process.env.SCAN_INTERVAL || '0 */4 * * *'  // Every 4 hours
}
```

#### **2. Database Access Layer**
```typescript
// lib/spliitService.ts
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export async function getUncategorizedExpenses() {
  return prisma.expense.findMany({
    where: { categoryId: 0 },  // Default/uncategorized
    include: { 
      category: true,
      paidBy: true,
      group: true 
    },
    take: 50  // Process in batches
  })
}

export async function getCategories() {
  return prisma.category.findMany()
}

export async function updateExpenseCategory(
  expenseId: string,
  categoryId: number
) {
  return prisma.expense.update({
    where: { id: expenseId },
    data: { categoryId }
  })
}
```

#### **3. Ollama Service (AI Layer)**
```javascript
// services/expenseCategoryService.js
class ExpenseCategoryService {
  constructor(ollamaUrl, model) {
    this.apiUrl = ollamaUrl
    this.model = model
    this.client = axios.create({ timeout: 60000 })
  }

  async categorizeExpense(expense, categories) {
    // Build prompt with category names
    const categoryList = categories
      .map(c => `${c.id}: ${c.grouping} > ${c.name}`)
      .join('\n')
    
    const prompt = `
Categorize this expense into one of these categories:
${categoryList}

Expense:
Title: ${expense.title}
Amount: ${expense.amount}
Date: ${expense.expenseDate}
Notes: ${expense.notes || 'none'}
Paid by: ${expense.paidBy.name}

Return ONLY valid JSON:
{
  "categoryId": <number>,
  "confidence": <0-1>,
  "reasoning": "<brief explanation>"
}
`
    
    const response = await this.client.post(`${this.apiUrl}/api/generate`, {
      model: this.model,
      prompt: prompt,
      stream: false,
      format: 'json'  // Structured output
    })
    
    return JSON.parse(response.data.response)
  }
}
```

#### **4. Main Service / Scheduler**
```javascript
// services/categorizationService.js
class CategorizationService {
  async processExpenses() {
    const expenses = await getUncategorizedExpenses()
    const categories = await getCategories()
    
    for (const expense of expenses) {
      try {
        const result = await ollamaService.categorizeExpense(
          expense, 
          categories
        )
        
        if (result.confidence > 0.7) {
          await updateExpenseCategory(
            expense.id,
            result.categoryId
          )
          console.log(`✓ Categorized: ${expense.title} → ${result.categoryId}`)
        } else {
          console.log(`⚠ Low confidence: ${expense.title} (${result.confidence})`)
        }
      } catch (error) {
        console.error(`✗ Error processing ${expense.id}:`, error.message)
      }
    }
  }
}

// Schedule it
cron.schedule(config.scanInterval, () => {
  categorizationService.processExpenses()
})
```

#### **5. Manual Interface (Playground)**
```javascript
// routes/expenseRoutes.js
app.post('/api/categorize-expense', async (req, res) => {
  const { expenseId, groupId } = req.body
  
  const expense = await getExpense(groupId, expenseId)
  const categories = await getCategories()
  
  const suggestions = await ollamaService.categorizeExpense(
    expense,
    categories
  )
  
  res.json({
    expense,
    suggestedCategoryId: suggestions.categoryId,
    confidence: suggestions.confidence,
    reasoning: suggestions.reasoning,
    availableCategories: categories
  })
})

app.post('/api/apply-category', async (req, res) => {
  const { expenseId, categoryId } = req.body
  await updateExpenseCategory(expenseId, categoryId)
  res.json({ success: true })
})
```

---

## 4. TECHNOLOGY CHOICES SUMMARY

| Aspect | Spliit | Paperless-AI | Recommended for Spliit-AI |
|--------|--------|--------------|--------------------------|
| **Language** | TypeScript | JavaScript | Node.js (TypeScript preferred) |
| **API Pattern** | tRPC | REST/Express | REST with Express or tRPC |
| **Database** | PostgreSQL + Prisma | SQLite3 + PostgreSQL | PostgreSQL + Prisma (consistency) |
| **LLM Integration** | Manual (OpenAI SDK) | Multi-provider Factory | Factory pattern (Ollama + fallback) |
| **Scheduling** | N/A | node-cron | node-cron for periodic categorization |
| **Frontend** | Next.js + React | EJS Templates | Next.js component for UI |
| **Docker Support** | Yes | Yes | Yes (compose with Ollama) |

---

## 5. KEY INTEGRATION POINTS

### Database Connection
- **Spliit uses**: `POSTGRES_PRISMA_URL` (pooled) + `POSTGRES_URL_NON_POOLING`
- **Share same database** or use separate schema in same PostgreSQL instance
- Use Prisma client from Spliit's `@prisma/client` package for type safety

### Category Mapping
- Spliit categories: `{ id, grouping, name }`
- Prompt Ollama with full category list
- Return categoryId from Spliit's Category model
- Update via `prisma.expense.update()`

### Expense Context for AI
- **Required**: `title`, `amount`, `notes` (if present)
- **Optional**: `paidBy.name`, `group.name`, `expenseDate`, `isReimbursement`
- **Avoid**: Splitting details (irrelevant to categorization)

### Error Handling
- Graceful degradation: Skip expenses with low confidence
- Batch processing: Handle partial failures
- Logging: Store attempts + results for audit trail

---

## 6. ENVIRONMENT VARIABLES (Spliit-AI)

```env
# Database
POSTGRES_PRISMA_URL=postgresql://...
POSTGRES_URL_NON_POOLING=postgresql://...

# Ollama
OLLAMA_API_URL=http://localhost:11434
OLLAMA_MODEL=mistral

# Scheduling
SCAN_INTERVAL=0 */4 * * *
MIN_CONFIDENCE_THRESHOLD=0.7

# Logging
LOG_LEVEL=info
```

---

## 7. DOCKER COMPOSE SETUP

```yaml
version: '3.8'
services:
  spliit:
    image: spliit:latest
    environment:
      POSTGRES_URL: postgresql://postgres:password@postgres:5432/spliit
    depends_on:
      - postgres
      - ollama

  spliit-ai:
    build: ./services/spliit-ai
    environment:
      POSTGRES_PRISMA_URL: postgresql://postgres:password@postgres:5432/spliit
      OLLAMA_API_URL: http://ollama:11434
      OLLAMA_MODEL: mistral
    depends_on:
      - postgres
      - ollama
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    environment:
      - OLLAMA_HOST=0.0.0.0:11434
    volumes:
      - ollama_data:/root/.ollama
    restart: unless-stopped

  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: spliit
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  ollama_data:
  postgres_data:
```

---

## Summary

**Spliit** is a Next.js/tRPC bill-splitting app with PostgreSQL backend featuring flexible categorization.

**Paperless-AI** demonstrates a battle-tested pattern for AI document processing with:
- Multi-provider LLM factory pattern
- Scheduled automated processing + manual web interface
- Structured JSON output from LLMs
- Confidence-based filtering
- Extensible architecture

**Spliit-AI** should follow **Paperless-AI's proven architecture**:
1. Express.js server for REST API + scheduler
2. Service layer for database + AI interaction
3. Factory pattern for Ollama/OpenAI switching
4. Cron-based automated categorization
5. Manual "playground" route for user review
6. PostgreSQL for consistency with Spliit
7. Docker Compose for easy deployment

This approach provides a scalable, maintainable system for expense auto-categorization.
