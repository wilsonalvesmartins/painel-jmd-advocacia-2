const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3000;

// Configuração do Pool de Conexão com o PostgreSQL
// As credenciais virão das variáveis de ambiente
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Middlewares
app.use(cors()); // Habilita o CORS para requisições de diferentes origens
app.use(express.json()); // Habilita o parsing de JSON no corpo das requisições

// Rota de teste
app.get('/api', (req, res) => {
  res.send('API do Painel JMD Advocacia está funcionando!');
});

// --- ROTAS DA API PARA PROCESSOS ---

// GET: Obter todos os processos
app.get('/api/processes', async (req, res) => {
  try {
    // Garante que a tabela exista
    await pool.query(`
      CREATE TABLE IF NOT EXISTS processes (
        id SERIAL PRIMARY KEY,
        numero TEXT NOT NULL,
        cliente TEXT NOT NULL,
        acao TEXT,
        link TEXT,
        situacao TEXT,
        audiencia DATE,
        obs TEXT,
        movimentacoes JSONB DEFAULT '[]'::jsonb,
        last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const result = await pool.query('SELECT * FROM processes ORDER BY last_updated DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro no servidor');
  }
});

// POST: Criar um novo processo
app.post('/api/processes', async (req, res) => {
  try {
    const { numero, cliente, acao, link, situacao, audiencia, obs } = req.body;
    const newProcess = await pool.query(
      'INSERT INTO processes (numero, cliente, acao, link, situacao, audiencia, obs, movimentacoes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [numero, cliente, acao, link, situacao, audiencia || null, obs, '[]']
    );
    res.status(201).json(newProcess.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro no servidor');
  }
});

// PUT: Atualizar um processo existente
app.put('/api/processes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { numero, cliente, acao, link, situacao, audiencia, obs } = req.body;
        const updatedProcess = await pool.query(
            'UPDATE processes SET numero = $1, cliente = $2, acao = $3, link = $4, situacao = $5, audiencia = $6, obs = $7, last_updated = CURRENT_TIMESTAMP WHERE id = $8 RETURNING *',
            [numero, cliente, acao, link, situacao, audiencia || null, obs, id]
        );
        if (updatedProcess.rows.length === 0) {
            return res.status(404).send('Processo não encontrado');
        }
        res.json(updatedProcess.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro no servidor');
    }
});

// POST: Adicionar uma movimentação a um processo
app.post('/api/processes/:id/movimentacoes', async (req, res) => {
    try {
        const { id } = req.params;
        const { texto } = req.body;

        if (!texto) {
            return res.status(400).send('O texto da movimentação é obrigatório');
        }

        const novaMovimentacao = {
            texto,
            data: new Date().toISOString(),
        };

        const updatedProcess = await pool.query(
            `UPDATE processes 
             SET movimentacoes = movimentacoes || $1::jsonb, last_updated = CURRENT_TIMESTAMP 
             WHERE id = $2 RETURNING *`,
            [JSON.stringify(novaMovimentacao), id]
        );

        if (updatedProcess.rows.length === 0) {
            return res.status(404).send('Processo não encontrado');
        }
        res.json(updatedProcess.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Erro no servidor');
    }
});


app.listen(port, () => {
  console.log(`API rodando na porta ${port}`);
});
