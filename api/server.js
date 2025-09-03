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
                process.exit(1);
            }
        }
    }
};

// --- FUNÇÃO PARA INICIALIZAR E ATUALIZAR O BANCO DE DADOS ---
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
                last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                proxima_audiencia DATE,
                links JSONB DEFAULT '[]',
                area_direito VARCHAR(100),
                tribunal VARCHAR(255),
                vara VARCHAR(255)
            );
        `);
        console.log('Tabela "processes" verificada/criada com sucesso.');

        // Adiciona novas colunas para V4
        await client.query("ALTER TABLE processes ADD COLUMN IF NOT EXISTS modo_audiencia VARCHAR(100);");
        await client.query("ALTER TABLE processes ADD COLUMN IF NOT EXISTS link_audiencia VARCHAR(512);");

        console.log('Colunas da V4 (modo e link da audiência) verificadas/adicionadas.');

    } catch (err) {
        console.error('Erro ao inicializar o banco de dados:', err);
    } finally {
        client.release();
    }
};


// --- ROTAS DA API ---

// Obter todos os processos com filtros
app.get('/api/processes', async (req, res) => {
    try {
        const { tribunal, vara, search } = req.query;
        let query = 'SELECT * FROM processes';
        const conditions = [];
        const params = [];

        if (tribunal && tribunal !== 'Todos') {
            const tribunais = tribunal.split(',');
            const a = tribunais.map((t, i) => `$${i + 1}`).join(',');
            conditions.push(`tribunal IN (${a})`);
            params.push(...tribunais);
        }
        
        let paramIndex = params.length + 1;

        if (vara) {
            conditions.push(`vara = $${paramIndex++}`);
            params.push(vara);
        }
        if (search) {
             conditions.push(`(numero ILIKE $${paramIndex} OR cliente ILIKE $${paramIndex})`);
             params.push(`%${search}%`);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ' ORDER BY last_updated DESC';
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao buscar processos.' });
    }
});

// Criar um novo processo
app.post('/api/processes', async (req, res) => {
    const { numero, cliente, area_direito, tribunal, vara, proxima_audiencia, modo_audiencia, link_audiencia } = req.body;
    if (!numero || !cliente) {
        return res.status(400).json({ message: 'Número do processo e nome do cliente são obrigatórios.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO processes (numero, cliente, area_direito, tribunal, vara, proxima_audiencia, modo_audiencia, link_audiencia) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [numero, cliente, area_direito, tribunal, vara, proxima_audiencia || null, modo_audiencia, link_audiencia]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao criar processo.' });
    }
});

// Atualizar informações de um processo
app.put('/api/processes/:id', async (req, res) => {
    const { id } = req.params;
    const { numero, cliente, proxima_audiencia, area_direito, tribunal, vara, modo_audiencia, link_audiencia } = req.body;
     if (!numero || !cliente) {
        return res.status(400).json({ message: 'Número do processo e nome do cliente são obrigatórios.' });
    }
    try {
        const result = await pool.query(
            'UPDATE processes SET numero = $1, cliente = $2, proxima_audiencia = $3, area_direito = $4, tribunal = $5, vara = $6, modo_audiencia = $7, link_audiencia = $8, last_updated = CURRENT_TIMESTAMP WHERE id = $9 RETURNING *',
            [numero, cliente, proxima_audiencia || null, area_direito, tribunal, vara, modo_audiencia, link_audiencia, id]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Processo não encontrado.' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao atualizar processo.' });
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
        id: Date.now(),
        descricao,
        timestamp: new Date().toISOString(),
        concluido: false,
        prazo_fatal: prazo_fatal || null
    };
    
    let query = 'UPDATE processes SET movimentacoes = movimentacoes || $1::jsonb, last_updated = CURRENT_TIMESTAMP';
    const params = [JSON.stringify(novaMovimentacao)];

    if (prazo_fatal) {
        query += ", status = 'Pendente de manifestação'";
    }

    query += ' WHERE id = $2 RETURNING *';
    params.push(id);

    try {
        const result = await pool.query(query, params);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Processo não encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao adicionar movimentação.' });
    }
});

// Atualizar uma movimentação específica
app.put('/api/processes/:id/movimentacoes/:movId', async (req, res) => {
    const { id, movId } = req.params;
    const { descricao, concluido } = req.body;

    try {
        const processRes = await pool.query('SELECT movimentacoes FROM processes WHERE id = $1', [id]);
        if (processRes.rowCount === 0) return res.status(404).json({ message: 'Processo não encontrado.' });

        const movimentacoes = processRes.rows[0].movimentacoes;
        const movIndex = movimentacoes.findIndex(m => m.id == movId);

        if (movIndex === -1) return res.status(404).json({ message: 'Movimentação não encontrada.' });

        movimentacoes[movIndex].descricao = descricao;
        movimentacoes[movIndex].concluido = concluido;

        const updateRes = await pool.query(
            'UPDATE processes SET movimentacoes = $1, last_updated = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [JSON.stringify(movimentacoes), id]
        );
        res.json(updateRes.rows[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao atualizar movimentação.' });
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
        if (result.rowCount === 0) return res.status(404).json({ message: 'Processo não encontrado.' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao atualizar status do processo.' });
    }
});

// Adicionar um link a um processo
app.post('/api/processes/:id/links', async (req, res) => {
    const { id } = req.params;
    const { url, descricao } = req.body;
    if(!url || !descricao) return res.status(400).json({ message: 'URL e descrição são obrigatórios.' });

    const novoLink = { id: Date.now(), url, descricao };
    try {
        const result = await pool.query(
            `UPDATE processes SET links = links || $1::jsonb, last_updated = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
            [JSON.stringify(novoLink), id]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Processo não encontrado.' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao adicionar link.' });
    }
});

// Remover um link de um processo
app.delete('/api/processes/:id/links/:linkId', async (req, res) => {
    const { id, linkId } = req.params;
    try {
        const linksAtuais = await pool.query('SELECT links FROM processes WHERE id = $1', [id]);
        if (linksAtuais.rows.length === 0) return res.status(404).json({ message: 'Processo não encontrado.' });
        
        const linksFiltrados = linksAtuais.rows[0].links.filter(link => link.id != linkId);

        const result = await pool.query(
            'UPDATE processes SET links = $1, last_updated = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [JSON.stringify(linksFiltrados), id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Erro ao remover link.' });
    }
});


// Rota para a página de Gestão
app.get('/api/gestao', async (req, res) => {
    try {
        const pendentesRes = await pool.query("SELECT id, numero, cliente FROM processes WHERE status = 'Pendente de manifestação' ORDER BY last_updated DESC");
        const execucaoRes = await pool.query("SELECT id, numero, cliente FROM processes WHERE status = 'Em fase de execução' ORDER BY last_updated DESC");
        const semanaRes = await pool.query(`
            SELECT p.numero, mov.*
            FROM processes p, jsonb_to_recordset(p.movimentacoes) AS mov(id numeric, descricao text, timestamp timestamptz, concluido boolean, prazo_fatal date)
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

// Rota para o Calendário
app.get('/api/calendario', async (req, res) => {
    try {
        const audienciasRes = await pool.query("SELECT numero, cliente, proxima_audiencia as date FROM processes WHERE proxima_audiencia IS NOT NULL");
        const prazosRes = await pool.query(`
            SELECT p.numero, p.cliente, mov.prazo_fatal as date, mov.descricao
            FROM processes p, jsonb_to_recordset(p.movimentacoes) AS mov(descricao text, prazo_fatal date, concluido boolean)
            WHERE mov.prazo_fatal IS NOT NULL AND mov.concluido = false
        `);

        res.json({
            audiencias: audienciasRes.rows,
            prazos: prazosRes.rows
        });
    } catch (err) {
         console.error("Erro ao buscar dados do calendário:", err);
        res.status(500).json({ message: "Erro ao buscar dados para o calendário." });
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

