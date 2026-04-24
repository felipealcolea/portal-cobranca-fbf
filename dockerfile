FROM node:18

# Instala Python
RUN apt-get update && apt-get install -y python3 python3-pip

# Cria diretório
WORKDIR /app

# Copia tudo
COPY . .

# Instala dependências
RUN npm install
RUN pip3 install -r requirements.txt

# Porta
EXPOSE 3000

# Start
CMD ["node", "server.js"]
