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
        // Cria a tabela principal se não existir
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

        // Adiciona novas colunas se elas não existirem (para atualizações futuras)
        await client.query("ALTER TABLE processes ADD COLUMN IF NOT EXISTS proxima_audiencia DATE;");
        await client.query("ALTER TABLE processes ADD COLUMN IF NOT EXISTS links JSONB DEFAULT '[]';");
        console.log('Colunas "proxima_audiencia" e "links" verificadas/adicionadas.');

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

// Atualizar informações de um processo (número, cliente, audiência)
app.put('/api/processes/:id', async (req, res) => {
    const { id } = req.params;
    const { numero, cliente, proxima_audiencia } = req.body;
     if (!numero || !cliente) {
        return res.status(400).json({ message: 'Número do processo e nome do cliente são obrigatórios.' });
    }
    try {
        const result = await pool.query(
            'UPDATE processes SET numero = $1, cliente = $2, proxima_audiencia = $3, last_updated = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
            [numero, cliente, proxima_audiencia || null, id]
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

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Inicia transação

        const novaMovimentacao = {
            descricao,
            timestamp: new Date().toISOString(),
            prazo_fatal: prazo_fatal || null
        };
        
        let query = 'UPDATE processes SET movimentacoes = movimentacoes || $1::jsonb, last_updated = CURRENT_TIMESTAMP';
        const params = [JSON.stringify(novaMovimentacao)];

        // Lógica corrigida: Se houver prazo fatal, muda o status para "Pendente de manifestação"
        if (prazo_fatal) {
            query += ", status = 'Pendente de manifestação'";
        }

        query += ' WHERE id = $2 RETURNING *';
        params.push(id);

        const result = await client.query(query, params);

        await client.query('COMMIT'); // Finaliza transação

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Processo não encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Erro ao adicionar movimentação.' });
    } finally {
        client.release();
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
        // Pega os links atuais, filtra o que será removido e atualiza o campo
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
            FROM processes p, jsonb_to_recordset(p.movimentacoes) AS mov(descricao text, timestamp timestamptz, prazo_fatal date)
            WHERE mov.timestamp >= DATE_TRUNC('week', NOW())
            ORDER BY mov.timestamp DESC;
        `);
        // Busca de dados para o calendário
        const audienciasRes = await pool.query("SELECT numero, cliente, proxima_audiencia as date FROM processes WHERE proxima_audiencia IS NOT NULL");
        const prazosRes = await pool.query(`
            SELECT p.numero, p.cliente, mov.prazo_fatal as date, mov.descricao
            FROM processes p, jsonb_to_recordset(p.movimentacoes) AS mov(descricao text, prazo_fatal date)
            WHERE mov.prazo_fatal IS NOT NULL
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

