# ETAPA 1: Usar a imagem oficial do Nginx
FROM nginx:1.25-alpine

# Copiar o arquivo de configuração personalizado do Nginx
# Este arquivo vai configurar o proxy reverso para a API
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copiar os arquivos do frontend (apenas o index.html)
COPY index.html /usr/share/nginx/html/

# Expor a porta 80
EXPOSE 80

# Comando para iniciar o Nginx
CMD ["nginx", "-g", "daemon off;"]

