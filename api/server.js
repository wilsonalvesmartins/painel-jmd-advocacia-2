const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÃO DA BASE DE DADOS ---
// As credenciais são lidas a partir das variáveis de ambiente
// que definimos no docker-compose.yml.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// --- FUNÇÃO PARA CRIAR A TABELA SE NÃO EXISTIR ---
const createTable = async () => {
  const client = await pool.connect();
  try {
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
  } catch (err) {
    console.error('Erro ao criar a tabela:', err);
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
    console.error('Erro ao buscar processos:', err);
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
      'INSERT INTO processes (numero, cliente, movimentacoes) VALUES ($1, $2, $3) RETURNING *',
      [numero, cliente, '[]'] // Inicia com uma lista de movimentações vazia
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao criar processo:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /api/processes/:id/movimentacoes - Adicionar uma nova movimentação
app.post('/api/processes/:id/movimentacoes', async (req, res) => {
  const { id } = req.params;
  const { description } = req.body;
  if (!description) {
    return res.status(400).json({ error: 'A descrição da movimentação é obrigatória.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Inicia a transação

    const newMovement = {
      description: description,
      timestamp: new Date().toISOString(),
    };
    
    // Atualiza o campo de movimentações e a data da última atualização
    const result = await client.query(
      `UPDATE processes 
       SET movimentacoes = movimentacoes || $1::jsonb,
           last_updated = CURRENT_TIMESTAMP
       WHERE id = $2 
       RETURNING *`,
      [JSON.stringify(newMovement), id]
    );

    await client.query('COMMIT'); // Confirma a transação

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Processo não encontrado.' });
    }
    res.json(result.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK'); // Desfaz a transação em caso de erro
    console.error('Erro ao adicionar movimentação:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  } finally {
    client.release();
  }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const startServer = async () => {
  let retries = 5;
  while (retries) {
    try {
      await pool.connect();
      console.log('Conexão com a base de dados PostgreSQL estabelecida com sucesso.');
      break;
    } catch (err) {
      console.error('Falha ao conectar ao PostgreSQL:', err.message);
      retries -= 1;
      console.log(`Tentativas restantes: ${retries}. Tentando novamente em 5 segundos...`);
      if (retries === 0) {
        console.error('Não foi possível conectar ao banco de dados após várias tentativas. A API não será iniciada.');
        return; // Impede o servidor de iniciar se a conexão falhar
      }
      await new Promise(res => setTimeout(res, 5000));
    }
  }

  // Apenas inicia o servidor se a conexão com a base de dados for bem-sucedida
  app.listen(port, async () => {
    await createTable(); // Garante que a tabela existe
    console.log(`Servidor da API a funcionar em http://localhost:${port}`);
  });
};

startServer();

