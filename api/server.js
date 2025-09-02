const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO DA CONEXÃO COM O BANCO DE DADOS ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// --- FUNÇÃO PARA CONECTAR COM TENTATIVAS ---
const connectWithRetry = async (retries = 5, delay = 5000) => {
    while (retries > 0) {
        try {
            await pool.connect();
            console.log('Conectado com sucesso ao PostgreSQL!');
            return;
        } catch (err) {
            retries--;
            console.error('Falha ao conectar ao PostgreSQL:', err.message);
            if (retries > 0) {
                console.log(`Tentativas restantes: ${retries}. Tentando novamente em ${delay / 1000} segundos...`);
                await new Promise(res => setTimeout(res, delay));
            } else {
                console.error('Não foi possível conectar ao banco de dados após várias tentativas. A API não será iniciada.');
                process.exit(1); // Encerra a aplicação se não conseguir conectar
            }
        }
    }
};

// --- FUNÇÃO PARA INICIALIZAR O BANCO DE DADOS ---
const initializeDatabase = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS processes (
                id SERIAL PRIMARY KEY,
                numero VARCHAR(255) NOT NULL,
                cliente VARCHAR(255) NOT NULL,
                status VARCHAR(100) DEFAULT 'Distribuído',
                movimentacoes JSONB DEFAULT '[]',
                last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Tabela "processes" verificada/criada com sucesso.');
    } catch (err) {
        console.error('Erro ao inicializar o banco de dados:', err);
    } finally {
        client.release();
    }
};


// --- ROTAS DA API ---

// Obter todos os processos
app.get('/api/processes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM processes ORDER BY last_updated DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao buscar processos.' });
    }
});

// Criar um novo processo
app.post('/api/processes', async (req, res) => {
    const { numero, cliente } = req.body;
    if (!numero || !cliente) {
        return res.status(400).json({ message: 'Número do processo e nome do cliente são obrigatórios.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO processes (numero, cliente) VALUES ($1, $2) RETURNING *',
            [numero, cliente]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao criar processo.' });
    }
});

// Adicionar uma nova movimentação a um processo
app.post('/api/processes/:id/movimentacoes', async (req, res) => {
    const { id } = req.params;
    const { descricao, prazo_fatal } = req.body;

    if (!descricao) {
        return res.status(400).json({ message: 'A descrição da movimentação é obrigatória.' });
    }

    const novaMovimentacao = {
        descricao,
        timestamp: new Date().toISOString(),
        prazo_fatal: prazo_fatal || null
    };

    try {
        const result = await pool.query(
            `UPDATE processes 
             SET movimentacoes = movimentacoes || $1::jsonb, last_updated = CURRENT_TIMESTAMP
             WHERE id = $2 RETURNING *`,
            [JSON.stringify(novaMovimentacao), id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Processo não encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao adicionar movimentação.' });
    }
});

// Atualizar o status de um processo
app.put('/api/processes/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) {
        return res.status(400).json({ message: 'O novo status é obrigatório.' });
    }
    try {
        const result = await pool.query(
            'UPDATE processes SET status = $1, last_updated = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [status, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Processo não encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao atualizar status do processo.' });
    }
});


// Rota para a página de Gestão
app.get('/api/gestao', async (req, res) => {
    try {
        // Processos pendentes de manifestação
        const pendentesRes = await pool.query("SELECT id, numero, cliente FROM processes WHERE status = 'Pendente de manifestação' ORDER BY last_updated DESC");

        // Processos em fase de execução
        const execucaoRes = await pool.query("SELECT id, numero, cliente FROM processes WHERE status = 'Em fase de execução' ORDER BY last_updated DESC");

        // Movimentações da semana
        // A função DATE_TRUNC('week', NOW()) obtém o início da semana atual (Segunda-feira)
        const semanaRes = await pool.query(`
            SELECT p.numero, mov.*
            FROM processes p, jsonb_to_recordset(p.movimentacoes) AS mov(descricao text, timestamp timestamptz, prazo_fatal date)
            WHERE mov.timestamp >= DATE_TRUNC('week', NOW())
            ORDER BY mov.timestamp DESC;
        `);
        
        res.json({
            pendentes: pendentesRes.rows,
            execucao: execucaoRes.rows,
            semana: semanaRes.rows
        });

    } catch (err) {
        console.error("Erro ao buscar dados de gestão:", err);
        res.status(500).json({ message: "Erro ao buscar dados para a página de gestão." });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const startServer = async () => {
    await connectWithRetry();
    await initializeDatabase();
    app.listen(port, () => {
        console.log(`API a funcionar na porta ${port}`);
    });
};

startServer();

