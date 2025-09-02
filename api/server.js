const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// Configuração da conexão com o PostgreSQL usando a variável de ambiente do Docker Compose
let pool;
const connectWithRetry = () => {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    pool.connect((err, client, release) => {
        if (err) {
            console.error('Falha ao conectar ao PostgreSQL:', err.message);
            console.log('Tentativas restantes:', 5 - retries);
            retries++;
            if (retries < 6) {
                setTimeout(connectWithRetry, 5000);
            } else {
                console.error('Não foi possível conectar ao banco de dados após várias tentativas. A API não será iniciada.');
            }
        } else {
            console.log('Conectado com sucesso ao PostgreSQL!');
            initializeDb();
            release();
        }
    });
};

let retries = 1;
connectWithRetry();


const initializeDb = async () => {
    try {
        // CORREÇÃO CRÍTICA: Cria a tabela principal se ela não existir.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS processes (
                id SERIAL PRIMARY KEY,
                numero VARCHAR(255) NOT NULL,
                cliente VARCHAR(255) NOT NULL,
                movimentacoes JSONB DEFAULT '[]',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        // Verifica e adiciona novas colunas à tabela processes se não existirem
        await pool.query('ALTER TABLE processes ADD COLUMN IF NOT EXISTS status VARCHAR(255)');
        await pool.query('ALTER TABLE processes ADD COLUMN IF NOT EXISTS proxima_audiencia DATE');
        await pool.query('ALTER TABLE processes ADD COLUMN IF NOT EXISTS links JSONB DEFAULT \'[]\'');
        await pool.query('ALTER TABLE processes ADD COLUMN IF NOT EXISTS tribunal VARCHAR(255)');
        await pool.query('ALTER TABLE processes ADD COLUMN IF NOT EXISTS vara VARCHAR(255)');
        
        // Cria a tabela de configurações se não existir
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(255) PRIMARY KEY,
                value JSONB
            );
        `);

        console.log('Tabelas "processes" e "settings" verificadas/criadas com sucesso.');
    } catch (err) {
        console.error('Erro ao inicializar o banco de dados:', err.stack);
    }
};

// --- ROTAS DE CONFIGURAÇÕES ---

// Obter configurações
app.get('/api/settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT value FROM settings WHERE key = $1', ['office_settings']);
        if (result.rows.length > 0) {
            res.json(result.rows[0].value);
        } else {
            res.json({ logo_url: '' }); // Retorna um objeto padrão se não houver configurações
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao obter configurações.' });
    }
});

// Salvar/Atualizar configurações
app.post('/api/settings', async (req, res) => {
    const { logo_url } = req.body;
    try {
        await pool.query(`
            INSERT INTO settings (key, value) 
            VALUES ($1, $2) 
            ON CONFLICT (key) 
            DO UPDATE SET value = $2;
        `, ['office_settings', { logo_url }]);
        res.status(200).json({ message: 'Configurações salvas com sucesso.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao salvar configurações.' });
    }
});


// --- ROTAS DE PROCESSOS ---

// Obter todos os processos com filtros
app.get('/api/processes', async (req, res) => {
    try {
        let query = 'SELECT * FROM processes ORDER BY created_at DESC';
        const params = [];
        const conditions = [];

        if (req.query.tribunal && req.query.tribunal !== 'Todos') {
            params.push(req.query.tribunal);
            conditions.push(`tribunal = $${params.length}`);
        }
        if (req.query.vara) {
            params.push(`%${req.query.vara}%`);
            conditions.push(`vara ILIKE $${params.length}`);
        }
        
        if (conditions.length > 0) {
            query = `SELECT * FROM processes WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao buscar processos.' });
    }
});

// Criar um novo processo
app.post('/api/processes', async (req, res) => {
    const { numero, cliente, tribunal, vara } = req.body;
    if (!numero || !cliente) {
        return res.status(400).json({ message: 'Número do processo e nome do cliente são obrigatórios.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO processes (numero, cliente, status, tribunal, vara) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [numero, cliente, 'Distribuído', tribunal, vara]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao criar processo.' });
    }
});

// Atualizar um processo (informações gerais)
app.put('/api/processes/:id', async (req, res) => {
    const { id } = req.params;
    const { numero, cliente, proxima_audiencia, tribunal, vara } = req.body;
    try {
        const result = await pool.query(
            'UPDATE processes SET numero = $1, cliente = $2, proxima_audiencia = $3, tribunal = $4, vara = $5 WHERE id = $6 RETURNING *',
            [numero, cliente, proxima_audiencia || null, tribunal, vara, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao atualizar processo.' });
    }
});


// Adicionar uma movimentação
app.post('/api/processes/:id/movimentacoes', async (req, res) => {
    const { id } = req.params;
    const { descricao, prazo_fatal } = req.body;
    const newMovimentacao = {
        id: Date.now(),
        descricao,
        timestamp: new Date(),
        prazo_fatal: prazo_fatal || null,
    };

    try {
        let query = 'UPDATE processes SET movimentacoes = movimentacoes || $1::jsonb';
        const params = [JSON.stringify(newMovimentacao)];
        
        if (prazo_fatal) {
            query += ', status = $2';
            params.push('Pendente de manifestação');
        }
        
        query += ' WHERE id = $' + (params.length + 1) + ' RETURNING *';
        params.push(id);

        const result = await pool.query(query, params);
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao adicionar movimentação.' });
    }
});

// Atualizar status de um processo
app.put('/api/processes/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query('UPDATE processes SET status = $1 WHERE id = $2 RETURNING *', [status, id]);
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao atualizar status.' });
    }
});

// Adicionar um link
app.post('/api/processes/:id/links', async (req, res) => {
    const { id } = req.params;
    const { url, descricao } = req.body;
    const newLink = { id: Date.now(), url, descricao };
    try {
        const result = await pool.query(
            'UPDATE processes SET links = links || $1::jsonb WHERE id = $2 RETURNING *',
            [JSON.stringify(newLink), id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao adicionar link.' });
    }
});

// Remover um link
app.delete('/api/processes/:processId/links/:linkId', async (req, res) => {
    const { processId, linkId } = req.params;
    try {
        const processResult = await pool.query('SELECT links FROM processes WHERE id = $1', [processId]);
        if (processResult.rows.length === 0) {
            return res.status(404).json({ message: 'Processo não encontrado.' });
        }
        const links = processResult.rows[0].links || [];
        const updatedLinks = links.filter(link => link.id != linkId);

        const result = await pool.query('UPDATE processes SET links = $1 WHERE id = $2 RETURNING *', [JSON.stringify(updatedLinks), processId]);
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao remover link.' });
    }
});


// --- ROTA DE GESTÃO ---
app.get('/api/gestao', async (req, res) => {
    try {
        // Processos pendentes de manifestação
        const pendentesRes = await pool.query("SELECT id, numero, cliente FROM processes WHERE status = 'Pendente de manifestação'");

        // Processos em fase de execução
        const execucaoRes = await pool.query("SELECT id, numero, cliente FROM processes WHERE status = 'Em fase de execução'");

        // Movimentações da semana
        const semanaRes = await pool.query(`
            SELECT p.numero, m.*
            FROM processes p, jsonb_to_recordset(p.movimentacoes) as m(descricao text, timestamp timestamptz)
            WHERE m.timestamp >= date_trunc('week', CURRENT_DATE)
            ORDER BY m.timestamp DESC
        `);

        // Dados para o calendário
        const audienciasRes = await pool.query("SELECT numero, proxima_audiencia as date FROM processes WHERE proxima_audiencia IS NOT NULL");
        const prazosRes = await pool.query(`
            SELECT p.numero, m.descricao, m.prazo_fatal as date
            FROM processes p, jsonb_to_recordset(p.movimentacoes) as m(descricao text, prazo_fatal date)
            WHERE m.prazo_fatal IS NOT NULL
        `);

        res.json({
            pendentes: pendentesRes.rows,
            execucao: execucaoRes.rows,
            semana: semanaRes.rows,
            calendario: {
                audiencias: audienciasRes.rows,
                prazos: prazosRes.rows
            }
        });
    } catch (err) {
        console.error('Erro ao buscar dados de gestão:', err);
        res.status(500).json({ message: 'Erro ao buscar dados de gestão.' });
    }
});


app.listen(PORT, () => {
    console.log(`API a funcionar na porta ${PORT}`);
});

