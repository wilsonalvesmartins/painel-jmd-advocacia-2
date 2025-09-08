# Usar uma imagem Node.js oficial
FROM node:18-alpine

# Instalar o curl para o healthcheck
RUN apk add --no-cache curl

# Definir o diretório de trabalho dentro do container
WORKDIR /usr/src/app

# Copiar o package.json e package-lock.json para o diretório de trabalho
COPY package*.json ./

# Instalar as dependências do projeto
RUN npm install

# Copiar o resto do código da aplicação
COPY . .

# Expor a porta que a API vai usar
EXPOSE 3000

# Comando para iniciar a aplicação
CMD [ "node", "server.js" ]
