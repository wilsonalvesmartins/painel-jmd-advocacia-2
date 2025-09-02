const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3000;

let pool;

// --- FUNÇÃO PARA CONECTAR AO BANCO DE DADOS COM TENTATIVAS ---
async function connectWithRetry() {
    let retries = 5;
    while (retries) {
        try {
            pool = new Pool({
                connectionString: process.env.DATABASE_URL,
            });
            await pool.connect();
            console.log("Conectado ao PostgreSQL com sucesso!");
            
            // Garante que a tabela de processos exista
            await pool.query(`
              CREATE TABLE IF NOT EXISTS processes (
                id SERIAL PRIMARY KEY,
                numero TEXT NOT NULL UNIQUE,
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
            console.log("Tabela 'processes' verificada/criada com sucesso.");

            break; // Sai do loop se a conexão for bem-sucedida
        } catch (err) {
            console.error("Falha ao conectar ao PostgreSQL:", err.message);
            retries -= 1;
            console.log(`Tentativas restantes: ${retries}. Tentando novamente em 5 segundos...`);
            // Espera 5 segundos antes de tentar novamente
            if (retries > 0) {
                await new Promise(res => setTimeout(res, 5000));
            } else {
                console.error("Não foi possível conectar ao banco de dados após várias tentativas. A API não será iniciada.");
                process.exit(1); // Encerra o processo se não conseguir conectar
            }
        }
    }
}


// --- INICIALIZAÇÃO E ROTAS DA API ---
async function startApi() {
    await connectWithRetry(); // Primeiro, conecta ao banco de dados

    // Middlewares
    app.use(cors());
    app.use(express.json());

    // Rota de teste
    app.get('/api', (req, res) => {
        res.send('API do Painel JMD Advocacia está funcionando e conectada ao banco de dados!');
    });

    // GET: Obter todos os processos
    app.get('/api/processes', async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM processes ORDER BY last_updated DESC');
            res.json(result.rows);
        } catch (err) {
            console.error("Erro ao buscar processos:", err);
            res.status(500).json({ error: 'Erro no servidor ao buscar processos.' });
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
            console.error("Erro ao criar processo:", err);
            if (err.code === '23505') { // Código de erro para violação de chave única
                return res.status(409).json({ error: 'Já existe um processo com este número.' });
            }
            res.status(500).json({ error: 'Erro no servidor ao criar processo.' });
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
                return res.status(404).json({ error: 'Processo não encontrado' });
            }
            res.json(updatedProcess.rows[0]);
        } catch (err) {
            console.error("Erro ao atualizar processo:", err);
            if (err.code === '23505') {
                return res.status(409).json({ error: 'Já existe outro processo com este número.' });
            }
            res.status(500).json({ error: 'Erro no servidor ao atualizar processo.' });
        }
    });

    // POST: Adicionar uma movimentação a um processo
    app.post('/api/processes/:id/movimentacoes', async (req, res) => {
        try {
            const { id } = req.params;
            const { texto } = req.body;
            if (!texto) return res.status(400).json({ error: 'O texto da movimentação é obrigatório' });
            
            const novaMovimentacao = { texto, data: new Date().toISOString() };
            const updatedProcess = await pool.query(
                `UPDATE processes SET movimentacoes = movimentacoes || $1::jsonb, last_updated = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
                [JSON.stringify(novaMovimentacao), id]
            );
            if (updatedProcess.rows.length === 0) {
                return res.status(404).json({ error: 'Processo não encontrado' });
            }
            res.json(updatedProcess.rows[0]);
        } catch (err) {
            console.error("Erro ao adicionar movimentação:", err);
            res.status(500).json({ error: 'Erro no servidor ao adicionar movimentação.' });
        }
    });

    app.listen(port, () => {
        console.log(`API pronta e a funcionar na porta ${port}`);
    });
}

startApi(); // Inicia a API

