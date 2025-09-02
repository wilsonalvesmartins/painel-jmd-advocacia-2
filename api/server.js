const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO DA BASE DE DADOS ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// --- FUNÇÕES DE INICIALIZAÇÃO DA BASE DE DADOS ---
const initializeDatabase = async () => {
  const client = await pool.connect();
  try {
    // Cria a tabela principal se não existir
    await client.query(`
      CREATE TABLE IF NOT EXISTS processes (
        id SERIAL PRIMARY KEY,
        numero VARCHAR(255) NOT NULL,
        cliente VARCHAR(255) NOT NULL,
        movimentacoes JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Tabela "processes" verificada/criada com sucesso.');

    // Adiciona a coluna de status se ela não existir (para atualizações sem perda de dados)
    const columns = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name='processes' AND column_name='status'
    `);
    if (columns.rows.length === 0) {
      await client.query(`
        ALTER TABLE processes 
        ADD COLUMN status VARCHAR(255) DEFAULT 'Distribuído'
      `);
      console.log('Coluna "status" adicionada à tabela "processes".');
    }

  } catch (err) {
    console.error('Erro ao inicializar a base de dados:', err);
  } finally {
    client.release();
  }
};


// --- ROTAS DA API ---

// GET /api/processes - Obter todos os processos
app.get('/api/processes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM processes ORDER BY last_updated DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao procurar processos:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /api/processes - Criar um novo processo
app.post('/api/processes', async (req, res) => {
  const { numero, cliente } = req.body;
  if (!numero || !cliente) {
    return res.status(400).json({ error: 'Número do processo e nome do cliente são obrigatórios.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO processes (numero, cliente, movimentacoes, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [numero, cliente, '[]', 'Distribuído'] // Status inicial
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao criar processo:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// PUT /api/processes/:id/status - Atualizar o status de um processo
app.put('/api/processes/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) {
        return res.status(400).json({ error: 'O novo status é obrigatório.' });
    }
    try {
        const result = await pool.query(
            'UPDATE processes SET status = $1, last_updated = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [status, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Processo não encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao atualizar status:', err);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});


// POST /api/processes/:id/movimentacoes - Adicionar uma nova movimentação
app.post('/api/processes/:id/movimentacoes', async (req, res) => {
  const { id } = req.params;
  const { description, prazoFatal } = req.body;
  if (!description) {
    return res.status(400).json({ error: 'A descrição da movimentação é obrigatória.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const newMovement = {
      description: description,
      timestamp: new Date().toISOString(),
      prazo_fatal: prazoFatal || null, // Adiciona o prazo fatal se existir
    };
    
    const result = await client.query(
      `UPDATE processes 
       SET movimentacoes = movimentacoes || $1::jsonb,
           last_updated = CURRENT_TIMESTAMP
       WHERE id = $2 
       RETURNING *`,
      [JSON.stringify(newMovement), id]
    );

    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Processo não encontrado.' });
    }
    res.json(result.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao adicionar movimentação:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  } finally {
    client.release();
  }
});

// GET /api/gestao - Obter dados para o painel de gestão
app.get('/api/gestao', async (req, res) => {
    try {
        const pendentesQuery = pool.query("SELECT * FROM processes WHERE status = 'Pendente de manifestação' ORDER BY last_updated DESC");
        const execucaoQuery = pool.query("SELECT * FROM processes WHERE status = 'Em fase de execução' ORDER BY last_updated DESC");
        
        // Esta query é mais complexa: ela extrai todas as movimentações de todos os processos
        // e depois filtra apenas as que ocorreram na última semana.
        const weeklyMovementsQuery = pool.query(`
            WITH all_movements AS (
                SELECT
                    p.id AS process_id,
                    p.numero,
                    p.cliente,
                    (m.value ->> 'description') AS description,
                    (m.value ->> 'timestamp')::timestamptz AS timestamp,
                    (m.value ->> 'prazo_fatal') AS prazo_fatal
                FROM
                    processes p,
                    jsonb_array_elements(p.movimentacoes) AS m
            )
            SELECT * FROM all_movements
            WHERE timestamp >= date_trunc('week', NOW())
            ORDER BY timestamp DESC;
        `);

        const [pendentesResult, execucaoResult, weeklyMovementsResult] = await Promise.all([
            pendentesQuery,
            execucaoQuery,
            weeklyMovementsQuery,
        ]);

        res.json({
            pendentes: pendentesResult.rows,
            emExecucao: execucaoResult.rows,
            movimentacoesSemana: weeklyMovementsResult.rows,
        });

    } catch (err) {
        console.error('Erro ao obter dados de gestão:', err);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const startServer = async () => {
  let retries = 5;
  while (retries) {
    try {
      const client = await pool.connect();
      console.log('Conexão com a base de dados PostgreSQL estabelecida com sucesso.');
      client.release();
      break;
    } catch (err) {
      console.error('Falha ao conectar ao PostgreSQL:', err.message);
      retries -= 1;
      console.log(`Tentativas restantes: ${retries}. Tentando novamente em 5 segundos...`);
      if (retries === 0) {
        console.error('Não foi possível conectar à base de dados após várias tentativas. A API não será iniciada.');
        return;
      }
      await new Promise(res => setTimeout(res, 5000));
    }
  }

  app.listen(port, async () => {
    await initializeDatabase(); // Garante que a base de dados está pronta
    console.log(`Servidor da API a funcionar na porta ${port}`);
  });
};

startServer();

